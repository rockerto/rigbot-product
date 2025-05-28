// rigbot-product/pages/api/chat.js
import { google } from 'googleapis'; // Asegúrate de tener googleapis instalado
import { getCalendarClient as getDefaultCalendarClient } from '@/lib/google'; // Renombramos para claridad
import OpenAI from 'openai';
import { logRigbotMessage } from "@/lib/rigbotLog";
import { DEFAULT_SYSTEM_PROMPT_TEMPLATE } from '@/lib/defaultSystemPromptTemplate';
import { db } from '@/lib/firebase-admin';

// ... (tus constantes y defaultConfig se mantienen igual) ...
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const MODEL_FALLBACK = process.env.OPENAI_MODEL || 'gpt-4o';
const CHILE_UTC_OFFSET_HOURS = -4;
const WHATSAPP_FALLBACK_PLACEHOLDER = "+56900000000";

const defaultConfig = {
  basePrompt: process.env.RIGBOT_PROMPT || DEFAULT_SYSTEM_PROMPT_TEMPLATE,
  calendarQueryDays: 7,
  calendarMaxUserRequestDays: 21,
  maxSuggestions: 5,
  whatsappNumber: process.env.RIGBOT_DEFAULT_WSP || WHATSAPP_FALLBACK_PLACEHOLDER,
  pricingInfo: "Nuestros precios son competitivos. Por favor, consulta al contactarnos.",
  direccion: "Nuestra consulta está en Copiapó. Te daremos los detalles exactos al agendar.",
  horario: "Atendemos de Lunes a Viernes, de 10:00 a 19:30.",
  chiropracticVideoUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  telefono: ""
};


function convertChileTimeToUtc(baseDateUtcDay, chileHour, chileMinute) { /* ... (sin cambios) ... */ 
  let utcHour = chileHour - CHILE_UTC_OFFSET_HOURS;
  const newUtcDate = new Date(baseDateUtcDay);
  newUtcDate.setUTCHours(utcHour, chileMinute, 0, 0);
  return newUtcDate;
}
function getDayIdentifier(dateObj, timeZone) { /* ... (sin cambios) ... */ 
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    timeZone: timeZone
  }).format(dateObj);
}

export default async function handler(req, res) {
  // ... (tu lógica de CORS y validación de método POST se mantiene igual) ...
  const allowedOriginsString = process.env.ALLOWED_ORIGINS || "https://rigsite-web.vercel.app";
  const allowedOrigins = allowedOriginsString.split(',').map(origin => origin.trim());
  const requestOrigin = req.headers.origin;
  let corsOriginSet = false;

  if (requestOrigin) {
    if (allowedOrigins.includes(requestOrigin)) {
      res.setHeader('Access-Control-Allow-Origin', requestOrigin);
      corsOriginSet = true;
    } else if (process.env.NODE_ENV === 'development' && requestOrigin.startsWith('http://localhost:')) {
      res.setHeader('Access-Control-Allow-Origin', requestOrigin);
      corsOriginSet = true;
    } else {
      console.warn("WARN CORS: Origen no está en la lista de permitidos y no es localhost dev:", requestOrigin, "| Permitidos:", allowedOrigins.join(' '));
    }
  } else {
    console.log("INFO CORS: No se detectó header 'origin'.");
  }
  
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Client-ID, Authorization'); 
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    if (corsOriginSet) { return res.status(204).end(); } 
    else { return res.status(403).json({ error: "Origen no permitido por CORS."}); }
  }

  if (req.method !== 'POST') { 
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const { message, sessionId: providedSessionId, clientId: bodyClientId, clave: incomingClave } = req.body || {};
  const requestClientId = bodyClientId; 

  console.log(`INFO: Request POST para /api/chat. ClientId: ${requestClientId}, Clave: ${incomingClave ? 'Presente' : 'Ausente'}`);

  const ipAddress = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null;
  const currentSessionId = providedSessionId || `session_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

  if (!db) { 
      console.error("FATAL en chat.js: Firestore (db) NO DISPONIBLE.");
      return res.status(500).json({ error: 'Error interno crítico del servidor.' });
  }

  // --- VALIDACIÓN DE CLIENTID Y CLAVE (como lo teníamos) ---
  if (!requestClientId || typeof requestClientId !== 'string') {
    return res.status(400).json({ error: "Client ID no válido o no proporcionado." });
  }
  let clientDocSnap;
  let clientConfigData;
  try {
    const clientDocRef = db.collection('clients').doc(requestClientId);
    clientDocSnap = await clientDocRef.get();
    if (!clientDocSnap.exists) {
      return res.status(403).json({ error: "Client ID no registrado. Acceso denegado." });
    }
    clientConfigData = clientDocSnap.data();
  } catch (error) {
    console.error(`API Chat: Error al verificar clientId '${requestClientId}' en Firestore:`, error);
    return res.status(500).json({ error: "Error interno al verificar el cliente." });
  }
  const expectedClave = clientConfigData?.clave;
  if (expectedClave && typeof expectedClave === 'string' && expectedClave.trim() !== "") {
    if (expectedClave !== incomingClave) { 
      if (typeof logRigbotMessage === "function") { try { await logRigbotMessage({ role: "system", content: `Intento de acceso con clave incorrecta. UserMsg: ${message}`, sessionId: currentSessionId, ip: ipAddress, clientId: requestClientId }); } catch(e){console.error("Log Error:",e)} }
      return res.status(401).json({ error: "Clave de API incorrecta para este Client ID." });
    }
  }
  // --- FIN VALIDACIÓN ---

  if (!message) { /* ... (tu manejo de error de mensaje faltante) ... */ 
    const errorResponsePayload = { error: 'Falta el mensaje del usuario' };
    if (typeof logRigbotMessage === "function") { try { await logRigbotMessage({ role: "assistant", content: `Error: ${errorResponsePayload.error}`, sessionId: currentSessionId, ip: ipAddress, clientId: requestClientId }); } catch(e){console.error("Log Error:",e)} }
    return res.status(400).json(errorResponsePayload);
  }
  if (typeof logRigbotMessage === "function") { /* ... (tu logueo de mensaje de usuario) ... */ 
    try {
      await logRigbotMessage({ role: "user", content: message, sessionId: currentSessionId, ip: ipAddress, clientId: requestClientId });
    } catch (logErr) {
      console.error("Error al loguear mensaje de usuario en Firestore:", logErr);
    }
  }

  let effectiveConfig = { ...defaultConfig };
  if (clientConfigData) { /* ... (tu lógica para poblar effectiveConfig desde clientConfigData) ... */ 
    console.log("INFO: Datos crudos desde Firestore:", JSON.stringify(clientConfigData, null, 2));
    effectiveConfig.basePrompt = clientConfigData.basePrompt || defaultConfig.basePrompt;
    effectiveConfig.whatsappNumber = clientConfigData.whatsappNumber || defaultConfig.whatsappNumber;
    effectiveConfig.pricingInfo = clientConfigData.pricingInfo || defaultConfig.pricingInfo;
    effectiveConfig.direccion = clientConfigData.direccion || defaultConfig.direccion;
    effectiveConfig.horario = clientConfigData.horario || defaultConfig.horario;
    effectiveConfig.chiropracticVideoUrl = clientConfigData.chiropracticVideoUrl || defaultConfig.chiropracticVideoUrl;
    effectiveConfig.telefono = clientConfigData.telefono || defaultConfig.telefono;
    // ... y los campos de calendario y maxSuggestions
    const firestoreCalendarQueryDays = Number(clientConfigData.calendarQueryDays);
    if (!isNaN(firestoreCalendarQueryDays) && firestoreCalendarQueryDays > 0) {
        effectiveConfig.calendarQueryDays = firestoreCalendarQueryDays;
    } else if (clientConfigData.calendarQueryDays !== undefined) {
        console.warn(`WARN: calendarQueryDays ('${clientConfigData.calendarQueryDays}') desde Firestore para ${requestClientId} no es válido, usando default: ${defaultConfig.calendarQueryDays}`);
    }
    const firestoreCalendarMaxUserRequestDays = Number(clientConfigData.calendarMaxUserRequestDays);
    if (!isNaN(firestoreCalendarMaxUserRequestDays) && firestoreCalendarMaxUserRequestDays > 0) {
        effectiveConfig.calendarMaxUserRequestDays = firestoreCalendarMaxUserRequestDays;
    } else if (clientConfigData.calendarMaxUserRequestDays !== undefined) {
        console.warn(`WARN: calendarMaxUserRequestDays ('${clientConfigData.calendarMaxUserRequestDays}') desde Firestore para ${requestClientId} no es válido, usando default: ${defaultConfig.calendarMaxUserRequestDays}`);
    }
    const firestoreMaxSuggestions = Number(clientConfigData.maxSuggestions);
    if (!isNaN(firestoreMaxSuggestions) && firestoreMaxSuggestions >= 0) {
        effectiveConfig.maxSuggestions = firestoreMaxSuggestions;
    } else if (clientConfigData.maxSuggestions !== undefined) {
        console.warn(`WARN: maxSuggestions ('${clientConfigData.maxSuggestions}') desde Firestore para ${requestClientId} no es válido, usando default: ${defaultConfig.maxSuggestions}`);
    }
  }
  console.log("🧠 Configuración efectiva usada para clientId", requestClientId, ":", JSON.stringify(effectiveConfig, null, 2));

  try {
    console.log(`📨 Mensaje ("${message}") recibido para ${requestClientId}`);
    const lowerMessage = message.toLowerCase();
    const calendarKeywords = [ /* ... tus keywords ... */ ];
    const isCalendarQuery = calendarKeywords.some(keyword => lowerMessage.includes(keyword));

    if (isCalendarQuery) {
      console.log(`⏳ Detectada consulta de calendario para ${requestClientId}`);
      let calendar; // Este será el cliente de Google Calendar a usar

      // ----- INICIO DE LÓGICA PARA USAR CALENDARIO DEL CLIENTE O DEFAULT -----
      if (clientConfigData && clientConfigData.googleCalendarConnected && clientConfigData.googleCalendarTokens) {
        console.log(`INFO: Cliente ${requestClientId} tiene Google Calendar conectado. Email: ${clientConfigData.googleCalendarEmail || 'No disponible'}. Usando sus tokens.`);
        try {
          const oauth2Client = new google.auth.OAuth2(
            process.env.GOOGLE_CLIENT_ID,      // Necesitas estas variables aquí
            process.env.GOOGLE_CLIENT_SECRET,  // Necesitas estas variables aquí
            process.env.GOOGLE_REDIRECT_URI    // Necesitas estas variables aquí
          );
          oauth2Client.setCredentials(clientConfigData.googleCalendarTokens);

          // Manejo de expiración de token (simplificado, la librería podría hacerlo)
          if (clientConfigData.googleCalendarTokens.refresh_token && 
              clientConfigData.googleCalendarTokens.expiry_date &&
              new Date().getTime() > (clientConfigData.googleCalendarTokens.expiry_date - 5 * 60 * 1000)) { // Si expira en menos de 5 mins
            console.log(`INFO: Access token para ${requestClientId} expirado o por expirar. Intentando refrescar...`);
            try {
                const { credentials } = await oauth2Client.refreshAccessToken();
                oauth2Client.setCredentials(credentials);
                // Actualizar tokens en Firestore
                await db.collection("clients").doc(requestClientId).set(
                    { googleCalendarTokens: credentials, googleCalendarLastSync: new Date().toISOString() },
                    { merge: true }
                );
                console.log(`INFO: Access token refrescado y actualizado en Firestore para ${requestClientId}.`);
            } catch (refreshError) {
                console.error(`ERROR: No se pudo refrescar el access token para ${requestClientId}:`, refreshError.message);
                // Si falla el refresh, podríamos volver al calendario por defecto o lanzar un error específico.
                // Por ahora, si falla el refresh, la siguiente llamada a la API de Calendar probablemente fallará.
                // O podríamos forzar el uso del calendario por defecto aquí.
                // Considerar revocar googleCalendarConnected: false si el refresh_token es inválido.
                 await db.collection("clients").doc(requestClientId).set(
                    { googleCalendarConnected: false, googleCalendarError: `Error al refrescar token: ${refreshError.message}` },
                    { merge: true }
                );
                console.warn(`WARN: Desconectando calendario para ${requestClientId} debido a error al refrescar token.`);
                calendar = await getDefaultCalendarClient(); // Volver al por defecto
                console.log(`INFO: Usando calendario por defecto para ${requestClientId} tras fallo de refresh token.`);
            }
          }
          if (calendar === undefined) { // Si no se volvió al default por error de refresh
            calendar = google.calendar({ version: 'v3', auth: oauth2Client });
            console.log(`INFO: Usando Google Calendar del cliente ${requestClientId} (Email: ${clientConfigData.googleCalendarEmail || 'N/A'})`);
          }

        } catch (oauthError) {
          console.error(`ERROR: No se pudo crear cliente OAuth2 para ${requestClientId} con sus tokens:`, oauthError.message);
          console.log(`INFO: Volviendo al calendario por defecto para ${requestClientId}.`);
          calendar = await getDefaultCalendarClient();
        }
      } else {
        console.log(`INFO: Cliente ${requestClientId} no tiene Google Calendar conectado o faltan tokens. Usando calendario por defecto.`);
        calendar = await getDefaultCalendarClient();
      }
      // ----- FIN DE LÓGICA PARA USAR CALENDARIO DEL CLIENTE O DEFAULT -----

      if (!calendar || typeof calendar.events?.list !== 'function') {
        console.error("ERROR: Cliente de calendario (ya sea del usuario o default) no está disponible o es inválido para", requestClientId);
        throw new Error("Cliente de calendario no inicializado correctamente.");
      }
      
      // ... (EL RESTO DE TU LÓGICA DE CALENDARIO DETALLADA VA AQUÍ, USANDO 'calendar') ...
      // Por ejemplo, en lugar de:
      // googleResponse = await calendar.events.list({ ... });
      // Ya tienes el 'calendar' correcto.
      // Ejemplo SIMPLIFICADO:
      const serverNowUtc = new Date();
      const calendarQueryStartUtc = new Date(serverNowUtc);
      const calendarQueryEndUtc = new Date(serverNowUtc);
      calendarQueryEndUtc.setDate(serverNowUtc.getDate() + effectiveConfig.calendarQueryDays);

      console.log(`🗓️ Google Calendar Query para ${requestClientId} (Calendario: ${clientConfigData?.googleCalendarConnected ? clientConfigData.googleCalendarEmail || 'Cliente' : 'Default'}): De ${calendarQueryStartUtc.toISOString()} a ${calendarQueryEndUtc.toISOString()}`);
      
      const googleResponse = await calendar.events.list({
          calendarId: 'primary', // Siempre 'primary' para el calendario principal del usuario autenticado
          timeMin: calendarQueryStartUtc.toISOString(),
          timeMax: calendarQueryEndUtc.toISOString(),
          singleEvents: true,
          orderBy: 'startTime'
      });
      
      // ... (tu lógica para procesar googleResponse.data.items, encontrar busySlots, availableSlotsOutput) ...
      // Esta es solo una simulación de tu lógica de calendario
      const eventsFromGoogle = googleResponse?.data?.items || [];
      let replyCalendar = `Se encontraron ${eventsFromGoogle.length} eventos en el calendario ${(clientConfigData?.googleCalendarEmail || (clientConfigData?.googleCalendarConnected ? 'del cliente' : 'default'))}.`;
      if (eventsFromGoogle.length === 0 && clientConfigData?.googleCalendarConnected) {
          replyCalendar = `No encontré eventos en tu calendario conectado (${clientConfigData.googleCalendarEmail}) para los próximos días. ¿Quieres que busque en otras fechas?`;
      } else if (eventsFromGoogle.length === 0) {
          replyCalendar = `No encontré eventos en el calendario de demostración.`;
      }


      console.log('✅ Respuesta generada (Calendario):', replyCalendar);
      if (typeof logRigbotMessage === "function") { try { await logRigbotMessage({ role: "assistant", content: replyCalendar, sessionId: currentSessionId, ip: ipAddress, clientId: requestClientId }); } catch(e){console.error("Log Error:",e)} }
      return res.status(200).json({ response: replyCalendar });
    }

    // --- Rama de OpenAI (sin cambios) ---
    // ... (tu lógica de OpenAI se mantiene) ...
    console.log('💡 Consulta normal, usando OpenAI para', requestClientId);
    let finalSystemPrompt = effectiveConfig.basePrompt;
    finalSystemPrompt = finalSystemPrompt.replace(/\$\{DAYS_TO_QUERY_CALENDAR\}/g, effectiveConfig.calendarQueryDays.toString());
    finalSystemPrompt = finalSystemPrompt.replace(/\$\{MAX_DAYS_FOR_USER_REQUEST\}/g, effectiveConfig.calendarMaxUserRequestDays.toString());
    if (effectiveConfig.whatsappNumber && effectiveConfig.whatsappNumber !== WHATSAPP_FALLBACK_PLACEHOLDER && effectiveConfig.whatsappNumber.trim() !== "") {
        finalSystemPrompt = finalSystemPrompt.replace(/\$\{whatsappNumber\}/g, effectiveConfig.whatsappNumber);
    } else {
        finalSystemPrompt = finalSystemPrompt.replace(/\$\{whatsappNumber\}/g, "nuestro principal canal de contacto telefónico o digital");
    }
    finalSystemPrompt = finalSystemPrompt.replace(/\$\{pricingInfo\}/g, effectiveConfig.pricingInfo);
    finalSystemPrompt = finalSystemPrompt.replace(/\$\{direccion\}/g, effectiveConfig.direccion);
    finalSystemPrompt = finalSystemPrompt.replace(/\$\{horario\}/g, effectiveConfig.horario);
    finalSystemPrompt = finalSystemPrompt.replace(/\$\{chiropracticVideoUrl\}/g, effectiveConfig.chiropracticVideoUrl);

    console.log(`System Prompt para OpenAI (clientId: ${requestClientId}, primeros 500 chars):`, finalSystemPrompt.substring(0, 500) + "...");
    const chatResponse = await openai.chat.completions.create({
      model: MODEL_FALLBACK,
      messages: [ { role: 'system', content: finalSystemPrompt }, { role: 'user', content: message } ]
    });
    let gptReply = chatResponse.choices[0].message.content.trim();
    console.log('✅ Respuesta generada (OpenAI):', gptReply);
    if (typeof logRigbotMessage === "function") { try { await logRigbotMessage({ role: "assistant", content: gptReply, sessionId: currentSessionId, ip: ipAddress, clientId: requestClientId }); } catch(e){console.error("Log Error:",e)} }
    return res.status(200).json({ response: gptReply });

  } catch (error) {
    // ... (tu manejo de error global se mantiene) ...
    console.error(`❌ Error en Rigbot para clientId ${requestClientId}:`, error);
    const errorForUser = 'Ocurrió un error inesperado en Rigbot. Por favor, intenta más tarde.';
    if (typeof logRigbotMessage === "function") { try { await logRigbotMessage({ role: "assistant", content: `Error interno: ${error.message}. UserMsg: ${errorForUser}`, sessionId: currentSessionId, ip: ipAddress, clientId: requestClientId }); } catch(e){console.error("Log Error:",e)} }
    return res.status(500).json({ 
        error: errorForUser, 
        details: process.env.NODE_ENV === 'development' ? error.message + (error.stack ? `\nStack: ${error.stack.substring(0,300)}...` : '') : undefined 
    });
  }
}