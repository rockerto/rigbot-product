// rigbot-product/pages/api/auth/google/callback.js
import { google } from 'googleapis';
import { db } from '@/lib/firebase-admin'; // Asumiendo que db se exporta y firebase-admin.ts maneja la inicialización

export default async function handler(req, res) {
  // Loguear el inicio de la función y las query params recibidas
  console.log("Callback: Función iniciada. Query params recibidos:", req.query);

  const { code, state, error: googleErrorParam } = req.query;
  const userId = state ? decodeURIComponent(state) : null;
  
  const frontendCalendarIntegrationUrl = process.env.FRONTEND_APP_URL 
                                       ? `${process.env.FRONTEND_APP_URL}/client/calendar-integration`
                                       : 'https://rigsite-web.vercel.app/client/calendar-integration'; // Fallback genérico

  // ----- LOGS DE DEPURACIÓN DE VARIABLES DE ENTORNO CRUCIALES -----
  const googleClientIdFromEnv = process.env.GOOGLE_CLIENT_ID;
  const googleClientSecretFromEnv = process.env.GOOGLE_CLIENT_SECRET;
  const googleRedirectUriFromEnv = process.env.GOOGLE_REDIRECT_URI;
  const frontendAppUrlFromEnv = process.env.FRONTEND_APP_URL;

  console.log("Callback: Verificando variables de entorno para OAuth y Redirección...");
  console.log("Callback: GOOGLE_CLIENT_ID leído:", googleClientIdFromEnv ? "Presente (Valor parcial: " + String(googleClientIdFromEnv).substring(0, 5) + "...)" : "AUSENTE o VACÍO");
  console.log("Callback: GOOGLE_CLIENT_SECRET leído:", googleClientSecretFromEnv ? "Presente (Valor parcial: " + String(googleClientSecretFromEnv).substring(0, 5) + "...)" : "AUSENTE o VACÍO");
  console.log("Callback: GOOGLE_REDIRECT_URI leído:", googleRedirectUriFromEnv ? googleRedirectUriFromEnv : "AUSENTE o VACÍO");
  console.log("Callback: FRONTEND_APP_URL leído:", frontendAppUrlFromEnv ? frontendAppUrlFromEnv : "AUSENTE o VACÍO");
  console.log("Callback: URL de redirección final calculada:", frontendCalendarIntegrationUrl);
  // ----------------------------------------------------------------

  if (googleErrorParam) {
    console.error(`Callback: Error recibido de Google para userId ${userId || 'desconocido'}:`, googleErrorParam);
    return res.redirect(`${frontendCalendarIntegrationUrl}?error=google_denied_access&details=${encodeURIComponent(String(googleErrorParam))}`);
  }

  if (!code || !userId) {
    console.error("Callback: Faltan parámetros 'code' o 'state' (userId).", { codeProvided: !!code, userIdProvided: !!userId });
    return res.redirect(`${frontendCalendarIntegrationUrl}?error=missing_params`);
  }

  // Verificar si las variables cruciales para OAuth2Client están presentes
  if (!googleClientIdFromEnv || !googleClientSecretFromEnv || !googleRedirectUriFromEnv) {
    console.error("Callback: Error crítico de configuración. Faltan GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, o GOOGLE_REDIRECT_URI en las variables de entorno del servidor.");
    return res.redirect(`${frontendCalendarIntegrationUrl}?error=server_config_error_oauth_creds`);
  }
  
  // Verificar si db está disponible (importada de firebase-admin)
  if (!db) {
    console.error("Callback: Error crítico de configuración. Instancia de Firestore 'db' no disponible desde firebase-admin.ts.");
    return res.redirect(`${frontendCalendarIntegrationUrl}?error=server_config_error_firestore`);
  }

  try {
    const oauth2Client = new google.auth.OAuth2(
      googleClientIdFromEnv, // Usar las variables leídas
      googleClientSecretFromEnv,
      googleRedirectUriFromEnv
    );

    console.log(`Callback: Intercambiando código por tokens para userId: ${userId}`);
    const { tokens } = await oauth2Client.getToken(String(code));
    console.log(`Callback: Tokens obtenidos para userId: ${userId}`, tokens ? `Sí (contiene refresh_token: ${!!tokens.refresh_token})` : 'No');

    if (!tokens || !tokens.access_token) {
      console.error(`Callback: No se pudo obtener access_token de Google para userId: ${userId}. Respuesta de tokens:`, tokens);
      return res.redirect(`${frontendCalendarIntegrationUrl}?error=token_exchange_failed`);
    }

    oauth2Client.setCredentials(tokens);

    let userEmail = null;
    let userName = null; 
    try {
      console.log(`Callback: Obteniendo información del perfil de Google para userId: ${userId}`);
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
      console.log(`Callback: Email de Google obtenido para userId ${userId}: ${userEmail}, Nombre: ${userName || 'No disponible'}`);
    } catch (userInfoError) {
      console.error(`Callback: Error obteniendo información del usuario de Google para userId ${userId}:`, userInfoError.message);
    }

    const clientDocRef = db.collection("clients").doc(userId);
    const dataToStore = {
      googleCalendarTokens: tokens, // Incluye access_token, refresh_token (si se concedió), expiry_date, etc.
      googleCalendarConnected: true,
      googleCalendarEmail: userEmail || null,
      ...(userName && { googleCalendarUserName: userName }), // Añadir solo si tenemos userName
      googleCalendarLastSync: new Date().toISOString(),
      googleCalendarError: null, // Limpiar errores anteriores
    };

    await clientDocRef.set(dataToStore, { merge: true });
    console.log(`Callback: Tokens y estado de Google Calendar guardados en Firestore para userId: ${userId}. Email: ${userEmail}`);

    return res.redirect(`${frontendCalendarIntegrationUrl}?success=calendar_connected&email=${encodeURIComponent(userEmail || '')}`);

  } catch (error) {
    console.error(`Callback: Error catastrófico en el proceso OAuth para userId ${userId || 'desconocido'}:`, error.message);
    // Loguear más detalles del error si están disponibles
    if (error.response && error.response.data) {
        console.error("Callback: Detalles del error de Gaxios/Google API:", error.response.data);
    } else if (error.stack) {
        console.error("Callback: Stacktrace del error:", error.stack);
    }

    let errorQueryParam = "oauth_callback_error_unknown";
    if (error.message && error.message.toLowerCase().includes("invalid_grant")) {
        errorQueryParam = "invalid_grant_or_code_used"; 
        console.warn("Callback: Posible error de 'invalid_grant'. El código de autorización podría ser inválido, haber expirado o ya haber sido utilizado.");
    } else if (error.response && error.response.data && error.response.data.error_description && error.response.data.error_description.toLowerCase().includes("client id")) {
        errorQueryParam = "client_id_mismatch_or_missing";
        console.warn("Callback: Error de Google API sugiere problema con Client ID en la petición de token.");
    }
    
    // Intentar guardar el error en Firestore para el usuario
    try {
        const clientDocRef = db.collection("clients").doc(userId); // userId podría ser null si state no vino
        if (userId) { // Solo intentar si tenemos userId
            await clientDocRef.set(
                { 
                    googleCalendarConnected: false,
                    googleCalendarError: `Callback Error: ${error.message || 'Error desconocido'}. Code: ${error.code || 'N/A'}. Details: ${JSON.stringify(error.response?.data)}`,
                    googleCalendarTokens: null, // Limpiar tokens si hubo error
                }, 
                { merge: true }
            );
            console.log(`Callback: Error de conexión con Google Calendar guardado en Firestore para userId: ${userId}`);
        }
    } catch (firestoreError) {
        console.error(`Callback: Error al intentar guardar el estado de error de Google Calendar en Firestore para userId ${userId}:`, firestoreError);
    }

    return res.redirect(`${frontendCalendarIntegrationUrl}?error=${errorQueryParam}`);
  }
}