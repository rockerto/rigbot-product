// rigbot-product/pages/api/chat.js
import { google } from 'googleapis'; // Asegúrate de tener googleapis instalado
import { getCalendarClient as getDefaultCalendarClient } from '@/lib/google'; // Renombramos para claridad
import OpenAI from 'openai';
import { logRigbotMessage } from "@/lib/rigbotLog";
import { DEFAULT_SYSTEM_PROMPT_TEMPLATE } from '@/lib/defaultSystemPromptTemplate';
import { db } from '@/lib/firebase-admin';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const MODEL_FALLBACK = process.env.OPENAI_MODEL || 'gpt-4o';
const CHILE_UTC_OFFSET_HOURS = -4; // Asegúrate que este valor sea correcto
const WHATSAPP_FALLBACK_PLACEHOLDER = "+56900000000"; // Para comparaciones

const defaultConfig = {
  basePrompt: process.env.RIGBOT_PROMPT || DEFAULT_SYSTEM_PROMPT_TEMPLATE,
  calendarQueryDays: 7,
  calendarMaxUserRequestDays: 21,
  maxSuggestions: 5, // Este es el valor por defecto si no viene de Firestore
  whatsappNumber: process.env.RIGBOT_DEFAULT_WSP || WHATSAPP_FALLBACK_PLACEHOLDER,
  pricingInfo: "Nuestros precios son competitivos. Por favor, consulta al contactarnos.",
  direccion: "Nuestra consulta está en Copiapó. Te daremos los detalles exactos al agendar.",
  horario: "Atendemos de Lunes a Viernes, de 10:00 a 19:30.",
  chiropracticVideoUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", // Placeholder
  telefono: "" // Placeholder
};

function convertChileTimeToUtc(baseDateUtcDay, chileHour, chileMinute) {
  let utcHour = chileHour - CHILE_UTC_OFFSET_HOURS;
  const newUtcDate = new Date(baseDateUtcDay); // Clonar para no modificar el original
  newUtcDate.setUTCHours(utcHour, chileMinute, 0, 0);
  return newUtcDate;
}

function getDayIdentifier(dateObj, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { // Formato YYYY-MM-DD
    year: 'numeric', month: '2-digit', day: '2-digit',
    timeZone: timeZone // Usar 'America/Santiago' para la lógica de días de Chile
  }).format(dateObj);
}

export default async function handler(req, res) {
  // --- Lógica de CORS (sin cambios) ---
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
    }
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
  // --- Fin Lógica de CORS ---

  const { message, sessionId: providedSessionId, clientId: bodyClientId, clave: incomingClave } = req.body || {};
  const requestClientId = bodyClientId; 

  console.log(`INFO: Request POST para /api/chat. ClientId: ${requestClientId}, Clave: ${incomingClave ? 'Presente' : 'Ausente'}`);

  const ipAddress = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null;
  const currentSessionId = providedSessionId || `session_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

  if (!db) { 
      console.error("FATAL en chat.js: Firestore (db) NO DISPONIBLE.");
      return res.status(500).json({ error: 'Error interno crítico del servidor.' });
  }

  // --- VALIDACIÓN DE CLIENTID Y CLAVE (sin cambios) ---
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
    console.log(`API Chat: Configuración del cliente ${requestClientId} obtenida de Firestore.`);
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

  if (!message) { 
    const errorResponsePayload = { error: 'Falta el mensaje del usuario' };
    if (typeof logRigbotMessage === "function") { try { await logRigbotMessage({ role: "assistant", content: `Error: ${errorResponsePayload.error}`, sessionId: currentSessionId, ip: ipAddress, clientId: requestClientId }); } catch(e){console.error("Log Error:",e)} }
    return res.status(400).json(errorResponsePayload);
  }
  if (typeof logRigbotMessage === "function") { 
    try { await logRigbotMessage({ role: "user", content: message, sessionId: currentSessionId, ip: ipAddress, clientId: requestClientId }); } 
    catch (logErr) { console.error("Error al loguear mensaje de usuario en Firestore:", logErr); }
  }

  let effectiveConfig = { ...defaultConfig };
  if (clientConfigData) { 
    console.log("INFO: Datos crudos de config del cliente desde Firestore:", JSON.stringify(clientConfigData, null, 2));
    effectiveConfig = { ...defaultConfig, ...clientConfigData }; // Sobrescribir defaults con config del cliente
    // Asegurar que los números sean números y tengan fallbacks si son inválidos
    effectiveConfig.calendarQueryDays = Number(clientConfigData.calendarQueryDays) || defaultConfig.calendarQueryDays;
    effectiveConfig.calendarMaxUserRequestDays = Number(clientConfigData.calendarMaxUserRequestDays) || defaultConfig.calendarMaxUserRequestDays;
    effectiveConfig.maxSuggestions = clientConfigData.maxSuggestions !== undefined ? Number(clientConfigData.maxSuggestions) : defaultConfig.maxSuggestions;
  }
  console.log("🧠 Configuración efectiva usada para clientId", requestClientId, ":", JSON.stringify(effectiveConfig, null, 2));

  // Funciones auxiliares para mensajes de WhatsApp (sin cambios)
  const getWhatsappContactMessage = (contactNumber) => { /* ... */ };
  const getWhatsappDerivationSuffix = (contactNumber) => { /* ... */ };
  // (Asegúrate de que estas funciones usen effectiveConfig.whatsappNumber)
  // const getWhatsappContactMessage = (contactNumber) => {
  //   if (contactNumber && contactNumber !== WHATSAPP_FALLBACK_PLACEHOLDER && String(contactNumber).trim() !== "") {
  //     return ` Para más detalles o para agendar, conversemos por WhatsApp 👉 ${contactNumber}`;
  //   }
  //   return " Para más detalles o para agendar, por favor contáctanos a través de nuestros canales principales.";
  // };
  // const getWhatsappDerivationSuffix = (contactNumber) => {
  //   if (contactNumber && contactNumber !== WHATSAPP_FALLBACK_PLACEHOLDER && String(contactNumber).trim() !== "") {
  //     return ` ¡Escríbenos por WhatsApp al 👉 ${contactNumber}!`;
  //   }
  //   return " ¡Contáctanos para coordinar!";
  // };


  try {
    console.log(`📨 Mensaje ("${message}") recibido para ${requestClientId}`);
    const lowerMessage = message.toLowerCase();
    const calendarKeywords = [ /* ... tus keywords ... */ 
        'hora', 'turno', 'disponibilidad', 'agenda', 'cuando', 'horario', 'disponible', 'libre', 'atiendes', 
        'ver', 'revisar', 'chequear', 'consultar', 'lunes', 'martes', 'miercoles', 'miércoles', 'jueves', 
        'viernes', 'sabado', 'sábado', 'domingo', 'hoy', 'mañana', 'tarde', 'a las', 'para el', 
        'tienes algo', 'hay espacio', 'agendar', 'agendamiento', 'proxima semana', 'próxima semana', 
        'prixima semana', 'procsima semana', 'proxima semama', 'proximo', 'próximo', 'priximo', 'procsimo'
    ];
    const isCalendarQuery = calendarKeywords.some(keyword => lowerMessage.includes(keyword));

    if (isCalendarQuery) {
      console.log(`⏳ Detectada consulta de calendario para ${requestClientId}`);
      let calendar; // Este será el cliente de Google Calendar a usar

      // ----- INICIO DE LÓGICA PARA USAR CALENDARIO DEL CLIENTE O DEFAULT -----
      if (clientConfigData && clientConfigData.googleCalendarConnected && clientConfigData.googleCalendarTokens) {
        console.log(`INFO: Cliente ${requestClientId} tiene Google Calendar conectado. Email: ${clientConfigData.googleCalendarEmail || 'No disponible en config'}. Intentando usar sus tokens.`);
        try {
          const oauth2Client = new google.auth.OAuth2(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET,
            process.env.GOOGLE_REDIRECT_URI 
          );
          oauth2Client.setCredentials(clientConfigData.googleCalendarTokens);

          // Manejo de expiración y refresco del access_token
          if (clientConfigData.googleCalendarTokens.refresh_token && 
              clientConfigData.googleCalendarTokens.expiry_date &&
              new Date().getTime() > (clientConfigData.googleCalendarTokens.expiry_date - 5 * 60 * 1000)) { // Si expira en menos de 5 mins
            console.log(`INFO: Access token para ${requestClientId} (Email: ${clientConfigData.googleCalendarEmail}) expirado o por expirar. Intentando refrescar...`);
            try {
                const { credentials } = await oauth2Client.refreshAccessToken(); // Usa .credentials
                oauth2Client.setCredentials(credentials); // Actualiza el cliente con los nuevos tokens
                // Actualizar tokens en Firestore
                await db.collection("clients").doc(requestClientId).set(
                    { googleCalendarTokens: credentials, googleCalendarLastSync: new Date().toISOString(), googleCalendarError: null },
                    { merge: true }
                );
                console.log(`INFO: Access token refrescado y actualizado en Firestore para ${requestClientId}.`);
                clientConfigData.googleCalendarTokens = credentials; // Actualiza la copia local para este request
            } catch (refreshError) {
                console.error(`ERROR: No se pudo refrescar el access token para ${requestClientId} (Email: ${clientConfigData.googleCalendarEmail}):`, refreshError.message);
                await db.collection("clients").doc(requestClientId).set(
                    { 
                        googleCalendarConnected: false, // Desconectar si el refresh_token es inválido
                        googleCalendarError: `Error al refrescar token: ${refreshError.message}. Por favor, reconecta tu calendario.`,
                        googleCalendarTokens: null // Podrías querer limpiar los tokens aquí
                    },
                    { merge: true }
                );
                console.warn(`WARN: Calendario desconectado para ${requestClientId} debido a error al refrescar token. Usando calendario por defecto.`);
                calendar = await getDefaultCalendarClient(); // Volver al por defecto
            }
          }
          // Si 'calendar' no fue asignado en el catch del refresh (o no hubo refresh), instanciarlo.
          if (calendar === undefined) { 
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
        calendar = await getDefaultCalendarClient(); // Tu función actual para el calendario demo/por defecto
      }
      // ----- FIN DE LÓGICA PARA USAR CALENDARIO DEL CLIENTE O DEFAULT -----

      if (!calendar || typeof calendar.events?.list !== 'function') {
        console.error("ERROR: Cliente de calendario (ya sea del usuario o default) no está disponible o es inválido para", requestClientId);
        // No lanzar error aquí, sino intentar responder al usuario que hay un problema con el calendario
        const errorMsg = "Lo siento, estoy teniendo problemas para acceder a la información de horarios en este momento. Por favor, intenta más tarde.";
        if (typeof logRigbotMessage === "function") { try { await logRigbotMessage({ role: "assistant", content: errorMsg, sessionId: currentSessionId, ip: ipAddress, clientId: requestClientId }); } catch(e){console.error("Log Error:",e)} }
        return res.status(503).json({ response: errorMsg }); // Service Unavailable
      }
      
      // ----- INICIO DE TU LÓGICA ORIGINAL DE PROCESAMIENTO DE CALENDARIO -----
      // (Asegúrate que todas las variables como serverNowUtc, refDateForTargetCalc, etc., se definan aquí)
      const serverNowUtc = new Date();
      let targetDateForDisplay = null;
      let targetDateIdentifierForSlotFilter = null;
      let targetHourChile = null;
      let targetMinuteChile = 0;
      let timeOfDay = null;
      let isGenericNextWeekSearch = false;

      const currentYearChile = parseInt(new Intl.DateTimeFormat('en-US', { year: 'numeric', timeZone: 'America/Santiago' }).format(serverNowUtc), 10);
      const currentMonthChile = parseInt(new Intl.DateTimeFormat('en-US', { month: 'numeric', timeZone: 'America/Santiago' }).format(serverNowUtc), 10) -1;
      const currentDayOfMonthChile = parseInt(new Intl.DateTimeFormat('en-US', { day: 'numeric', timeZone: 'America/Santiago' }).format(serverNowUtc), 10);
      // Usamos CHILE_UTC_OFFSET_HOURS para calcular el inicio del día en Chile en UTC
      const todayChile0000UtcTimestamp = Date.UTC(currentYearChile, currentMonthChile, currentDayOfMonthChile, 0 - CHILE_UTC_OFFSET_HOURS, 0, 0, 0);
      const refDateForTargetCalc = new Date(todayChile0000UtcTimestamp); // Referencia para cálculos de días futuros
      const actualCurrentDayOfWeekInChile = refDateForTargetCalc.getUTCDay(); // 0 (Dom) - 6 (Sab)

      // ... (TODA TU LÓGICA DE PARSEO DE lowerMessage para determinar targetDateForDisplay, targetHourChile, timeOfDay, isGenericNextWeekSearch va aquí, igual a como la tenías en la respuesta #69)
      // Esta lógica es extensa, la omito aquí por brevedad pero DEBES asegurarte que esté aquí.
      // EJEMPLO de cómo empezaba tu lógica:
      const isProximoWordQuery = calendarKeywords.some(k => k.startsWith("proximo") && lowerMessage.includes(k));
      const isAnyNextWeekIndicator = calendarKeywords.some(k => k.includes("semana") && lowerMessage.includes(k));
      let specificDayKeywordIndex = -1;
      const dayKeywordsList = [
        { keyword: 'domingo', index: 0 }, { keyword: 'lunes', index: 1 }, { keyword: 'martes', index: 2 },
        { keyword: 'miercoles', index: 3 }, { keyword: 'miércoles', index: 3 }, { keyword: 'jueves', index: 4 },
        { keyword: 'viernes', index: 5 }, { keyword: 'sabado', index: 6 }, { keyword: 'sábado', index: 6 }
      ];
      for (const dayInfo of dayKeywordsList) { if (lowerMessage.includes(dayInfo.keyword)) { specificDayKeywordIndex = dayInfo.index; break; } }
      
      if (lowerMessage.includes('hoy')) {
        targetDateForDisplay = new Date(refDateForTargetCalc);
      } else if (lowerMessage.includes('mañana') && !lowerMessage.includes('pasado mañana')) {
        targetDateForDisplay = new Date(refDateForTargetCalc);
        targetDateForDisplay.setUTCDate(targetDateForDisplay.getUTCDate() + 1);
      } else if (specificDayKeywordIndex !== -1) {
          targetDateForDisplay = new Date(refDateForTargetCalc);
          let daysToAdd = specificDayKeywordIndex - actualCurrentDayOfWeekInChile;
          if (daysToAdd < 0) { daysToAdd += 7; }
          if ((isAnyNextWeekIndicator && daysToAdd < 7) || (daysToAdd === 0 && isProximoWordQuery)) {
            if (!(daysToAdd >=7 && isAnyNextWeekIndicator)) { daysToAdd += 7; }
          } else if (daysToAdd === 0 && !isProximoWordQuery && serverNowUtc.getUTCHours() >= (19 - CHILE_UTC_OFFSET_HOURS)) {
            daysToAdd += 7;
          }
          targetDateForDisplay.setUTCDate(targetDateForDisplay.getUTCDate() + daysToAdd);
      } else if (isAnyNextWeekIndicator) {
          targetDateForDisplay = new Date(refDateForTargetCalc);
          let daysUntilNextMonday = (1 - actualCurrentDayOfWeekInChile + 7) % 7;
          if (daysUntilNextMonday === 0 && !isProximoWordQuery) daysUntilNextMonday = 7;
          targetDateForDisplay.setUTCDate(targetDateForDisplay.getUTCDate() + daysUntilNextMonday);
          isGenericNextWeekSearch = true;
      }

      if (targetDateForDisplay) {
        console.log(`🎯 Fecha Objetivo para ${requestClientId}: ${new Intl.DateTimeFormat('es-CL', { dateStyle: 'full', timeZone: 'America/Santiago' }).format(targetDateForDisplay)} (UTC: ${targetDateForDisplay.toISOString()})`);
        const futureLimitCheckDate = new Date(refDateForTargetCalc);
        futureLimitCheckDate.setUTCDate(futureLimitCheckDate.getUTCDate() + effectiveConfig.calendarMaxUserRequestDays);
        if (targetDateForDisplay >= futureLimitCheckDate) {
          const formattedDateAsked = new Intl.DateTimeFormat('es-CL', { dateStyle: 'long', timeZone: 'America/Santiago' }).format(targetDateForDisplay);
          let reply = `¡Entiendo que buscas para el ${formattedDateAsked}! 😊 Por ahora, mi calendario mental solo llega hasta unos ${effectiveConfig.calendarMaxUserRequestDays} días en el futuro.${getWhatsappContactMessage(effectiveConfig.whatsappNumber)} y mis colegas humanos te ayudarán con gusto.`;
          if (typeof logRigbotMessage === "function") { try { await logRigbotMessage({ role: "assistant", content: reply, sessionId: currentSessionId, ip: ipAddress, clientId: requestClientId }); } catch(e){console.error("Log Error:",e)} }
          return res.status(200).json({ response: reply });
        }
      }
            
      targetDateIdentifierForSlotFilter = (targetDateForDisplay && !isGenericNextWeekSearch) ? getDayIdentifier(targetDateForDisplay, 'America/Santiago') : null;
      if(targetDateIdentifierForSlotFilter) { console.log(`🏷️ Identificador de Fecha para Filtro (Chile YAML-MM-DD) para ${requestClientId}: ${targetDateIdentifierForSlotFilter}`); }
      else if (targetDateForDisplay && isGenericNextWeekSearch) { console.log(`🏷️ Búsqueda genérica para la semana que comienza el ${getDayIdentifier(targetDateForDisplay, 'America/Santiago')} para ${requestClientId}, sin filtro de día específico.`); }
      else { console.log(`🏷️ Búsqueda genérica desde hoy para ${requestClientId}, sin filtro de día específico.`); }
            
      const timeMatch = lowerMessage.match(/(\d{1,2})\s*(:(00|30|15|45))?\s*(pm|am|h|hr|hrs)?/i);
      if (timeMatch) {
        let hour = parseInt(timeMatch[1], 10);
        targetMinuteChile = timeMatch[3] ? parseInt(timeMatch[3], 10) : 0;
        // ... (resto de tu lógica de parseo de hora)
        const isPm = timeMatch[4] && timeMatch[4].toLowerCase() === 'pm';
        const isAm = timeMatch[4] && timeMatch[4].toLowerCase() === 'am';
        if (isPm && hour >= 1 && hour <= 11) hour += 12;
        if (isAm && hour === 12) hour = 0; // 12 AM es 00 horas
        targetHourChile = hour;
        // Ajustar minutos al cuarto de hora más cercano o al bloque que uses
        if (targetMinuteChile > 0 && targetMinuteChile < 15) targetMinuteChile = 0;
        else if (targetMinuteChile > 15 && targetMinuteChile < 30) targetMinuteChile = 15; // O 0 si solo manejas medias horas
        else if (targetMinuteChile > 30 && targetMinuteChile < 45) targetMinuteChile = 30;
        else if (targetMinuteChile > 45 && targetMinuteChile < 60) targetMinuteChile = 45; // O 30 si solo manejas medias horas
        console.log(`⏰ Hora objetivo (Chile) para ${requestClientId}: ${targetHourChile}:${targetMinuteChile.toString().padStart(2,'0')}`);
      }

      // ... (Lógica para timeOfDay)
      if (!targetHourChile && !isAnyNextWeekIndicator && !isProximoWordQuery && !(targetDateForDisplay && getDayIdentifier(targetDateForDisplay, 'America/Santiago') !== getDayIdentifier(refDateForTargetCalc, 'America/Santiago'))) {
        if ((lowerMessage.includes('mañana') && !lowerMessage.includes('pasado mañana'))) {
            if (targetDateForDisplay && getDayIdentifier(targetDateForDisplay, 'America/Santiago') === getDayIdentifier(new Date(refDateForTargetCalc.getTime() + 24*60*60*1000), 'America/Santiago')) {
                timeOfDay = 'morning'; // O el default que quieras para "mañana"
            }
        } else if (lowerMessage.includes('tarde')) {
            timeOfDay = 'afternoon';
        }
         if(timeOfDay) console.log(`🕒 Franja horaria solicitada para ${requestClientId}: ${timeOfDay}`);
      }
      // ... (Validación de WORKING_HOURS_CHILE_NUMERIC)
      const WORKING_HOURS_CHILE_NUMERIC = [10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5, 14, 14.5, 15, 15.5, 16, 16.5, 17, 17.5, 18, 18.5, 19, 19.5];
      if (targetHourChile !== null) {
        const requestedTimeNumeric = targetHourChile + (targetMinuteChile / 60);
        if (!WORKING_HOURS_CHILE_NUMERIC.includes(requestedTimeNumeric) || requestedTimeNumeric < 10 || requestedTimeNumeric > 19.5) {
          // ... (tu mensaje de error de fuera de horario)
          let replyPreamble = `¡Ojo! 👀 Parece que las ${targetHourChile.toString().padStart(2,'0')}:${targetMinuteChile.toString().padStart(2,'0')}`;
          if (targetDateForDisplay) {
            replyPreamble = `¡Ojo! 👀 Parece que el ${new Intl.DateTimeFormat('es-CL', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Santiago' }).format(targetDateForDisplay)} a las ${targetHourChile.toString().padStart(2,'0')}:${targetMinuteChile.toString().padStart(2,'0')}`;
          }
          let reply = `${replyPreamble} está fuera de nuestro horario de atención (${effectiveConfig.horario}). ¿Te gustaría buscar dentro de ese rango?${getWhatsappContactMessage(effectiveConfig.whatsappNumber)}`;
          if (typeof logRigbotMessage === "function") { try { await logRigbotMessage({ role: "assistant", content: reply, sessionId: currentSessionId, ip: ipAddress, clientId: requestClientId }); } catch(e){console.error("Log Error:",e)} }
          return res.status(200).json({ response: reply });
        }
      }
      // ----- FIN LÓGICA DE PARSEO -----

      let calendarQueryStartUtc = targetDateForDisplay ? new Date(targetDateForDisplay.getTime()) : new Date(refDateForTargetCalc.getTime());
      const calendarQueryEndUtc = new Date(calendarQueryStartUtc);
      calendarQueryEndUtc.setUTCDate(calendarQueryStartUtc.getUTCDate() + effectiveConfig.calendarQueryDays);
      
      console.log(`🗓️ Google Calendar Query para ${requestClientId} (Calendario: ${clientConfigData?.googleCalendarConnected && clientConfigData.googleCalendarEmail ? clientConfigData.googleCalendarEmail : (clientConfigData?.googleCalendarConnected ? 'Cliente (email no obtenido)' : 'Default')}): De ${calendarQueryStartUtc.toISOString()} a ${calendarQueryEndUtc.toISOString()}`);
      
      let googleResponse;
      try {
        googleResponse = await calendar.events.list({
            calendarId: 'primary',
            timeMin: calendarQueryStartUtc.toISOString(),
            timeMax: calendarQueryEndUtc.toISOString(),
            singleEvents: true,
            orderBy: 'startTime',
            // maxResults: 250 // Considera limitar si esperas muchos eventos
        });
      } catch (googleError) {
          console.error(`❌ ERROR DIRECTO en calendar.events.list para ${requestClientId}:`, googleError.message);
          // Si es un error de autenticación con el token del usuario, podríamos intentar desconectar el calendario.
          if (googleError.code === 401 || (googleError.errors && googleError.errors.some(e => e.reason === 'authError'))) {
              console.warn(`WARN: Error de autenticación al leer calendario de ${requestClientId}. Desconectando su calendario.`);
              await db.collection("clients").doc(requestClientId).set(
                  { googleCalendarConnected: false, googleCalendarError: `Error de autenticación al leer calendario: ${googleError.message}. Por favor, reconecta.`, googleCalendarTokens: null },
                  { merge: true }
              );
          }
          const errorResponsePayload = { error: 'Error al consultar el calendario de Google.', details: googleError.message };
          if (typeof logRigbotMessage === "function") { try { await logRigbotMessage({ role: "assistant", content: `Error interno: ${errorResponsePayload.error} Detalles: ${errorResponsePayload.details}`, sessionId: currentSessionId, ip: ipAddress, clientId: requestClientId });} catch(e){console.error("Log Error:",e)} }
          return res.status(500).json(errorResponsePayload);
      }
            
      const eventsFromGoogle = googleResponse?.data?.items || [];
      console.log(`INFO: Se obtuvieron ${eventsFromGoogle.length} eventos del calendario para ${requestClientId}.`);
      // Aquí tu lógica original para transformar eventsFromGoogle en busySlots
      const busySlots = eventsFromGoogle.filter(e => e.status !== 'cancelled')
        .map(e => {
            if (e.start?.dateTime && e.end?.dateTime) {
              return { start: new Date(e.start.dateTime).getTime(), end: new Date(e.end.dateTime).getTime() };
            } else if (e.start?.date && e.end?.date) { // Eventos de día completo
              const startDateAllDayUtc = new Date(e.start.date); // Ya es UTC
              const endDateAllDayUtc = new Date(e.end.date);   // Ya es UTC
              // Para eventos de día completo, el 'end' es exclusivo. Si dura 1 día, start=2023-10-10, end=2023-10-11
              // Lo trataremos como ocupado desde las 00:00 del día de inicio hasta las 00:00 del día de fin.
              return { start: startDateAllDayUtc.getTime(), end: endDateAllDayUtc.getTime() };
            }
            return null;
        }).filter(Boolean);

      // ... (EL RESTO DE TU LÓGICA para calcular availableSlotsOutput basada en busySlots y WORKING_HOURS_CHILE_STR)
      // Esta lógica es extensa, asegúrate que esté aquí completa y correcta.
      // EJEMPLO de cómo empezaba:
      const WORKING_HOURS_CHILE_STR = ['10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30', '14:00', '14:30', '15:00', '15:30', '16:00', '16:30', '17:00', '17:30', '18:00', '18:30', '19:00', '19:30'];
      const availableSlotsOutput = [];
      const processedDaysForGenericQuery = new Set();
      let baseIterationDateDayUtcStart = targetDateForDisplay ? new Date(targetDateForDisplay) : new Date(refDateForTargetCalc);

      console.log(`DEBUG: Iniciando bucle de ${effectiveConfig.calendarQueryDays} días para ${requestClientId}. Base UTC para iteración: ${baseIterationDateDayUtcStart.toISOString()}`);
      for (let i = 0; i < effectiveConfig.calendarQueryDays; i++) {
        const currentDayProcessingUtcStart = new Date(baseIterationDateDayUtcStart);
        currentDayProcessingUtcStart.setUTCDate(baseIterationDateDayUtcStart.getUTCDate() + i);
        for (const timeChileStr of WORKING_HOURS_CHILE_STR) {
            const [hChile, mChile] = timeChileStr.split(':').map(Number);
            if (targetHourChile !== null) { // Si el usuario pidió una hora específica
              if (hChile !== targetHourChile || mChile !== targetMinuteChile) { continue; }
            } else if (timeOfDay && !isGenericNextWeekSearch && !(isAnyNextWeekIndicator && !targetDateIdentifierForSlotFilter && !isProximoWordQuery) ) { // Si pidió mañana/tarde
              if (timeOfDay === 'morning' && (hChile < 10 || hChile >= 14)) continue; // Mañana hasta antes de las 14:00
              if (timeOfDay === 'afternoon' && (hChile < 14 || hChile > 19 || (hChile === 19 && mChile > 30))) continue; // Tarde desde las 14:00
            }
            const slotStartUtc = convertChileTimeToUtc(currentDayProcessingUtcStart, hChile, mChile);
            if (isNaN(slotStartUtc.getTime())) { console.warn("SlotStartUtc inválido:", currentDayProcessingUtcStart, hChile, mChile); continue; }
            
            const slightlyFutureServerNowUtc = new Date(serverNowUtc.getTime() + 1 * 60 * 1000); // Considerar slots que empiezan en 1 min
            if (slotStartUtc < slightlyFutureServerNowUtc) { continue; } // No mostrar slots pasados o muy inminentes

            const slotDayIdentifierInChile = getDayIdentifier(slotStartUtc, 'America/Santiago');
            if (targetDateIdentifierForSlotFilter) { // Si se busca un día específico
              if (slotDayIdentifierInChile !== targetDateIdentifierForSlotFilter) { continue; }
            }
            
            const slotEndUtc = new Date(slotStartUtc);
            slotEndUtc.setUTCMinutes(slotEndUtc.getUTCMinutes() + 30); // Asumiendo citas de 30 min
            
            const isBusy = busySlots.some(busy => slotStartUtc.getTime() < busy.end && slotEndUtc.getTime() > busy.start);
            
            if (!isBusy) {
              const formattedSlot = new Intl.DateTimeFormat('es-CL', {weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'America/Santiago'}).format(slotStartUtc);
              if (!targetDateIdentifierForSlotFilter && !targetHourChile) { // Búsqueda genérica
                  if (availableSlotsOutput.length < effectiveConfig.maxSuggestions * 2) { // Un poco más para filtrar
                    if (!processedDaysForGenericQuery.has(slotDayIdentifierInChile) || availableSlotsOutput.length < 2) { // Primeros 2 de cualquier día
                        availableSlotsOutput.push(formattedSlot); processedDaysForGenericQuery.add(slotDayIdentifierInChile);
                    } else if (Array.from(processedDaysForGenericQuery).length < 3 && availableSlotsOutput.filter(s => s.startsWith(new Intl.DateTimeFormat('es-CL', {weekday: 'long', timeZone: 'America/Santiago'}).format(slotStartUtc))).length < 2) { // Máx 2 por día hasta tener 3 días
                        availableSlotsOutput.push(formattedSlot);
                    }
                  }
              } else { // Búsqueda específica de día u hora
                availableSlotsOutput.push(formattedSlot);
              }
            }
        }
        // Lógica de corte de bucle
        if (targetDateIdentifierForSlotFilter && getDayIdentifier(currentDayProcessingUtcStart, 'America/Santiago') === targetDateIdentifierForSlotFilter) {
            if (targetHourChile !== null || availableSlotsOutput.length >= effectiveConfig.maxSuggestions ) break; // Si es hora específica, o ya tenemos suficientes para el día
        }
        if (availableSlotsOutput.length >= effectiveConfig.maxSuggestions && !targetDateIdentifierForSlotFilter && !targetHourChile && processedDaysForGenericQuery.size >=2) break; // Para búsqueda general
      }
      // ----- FIN TU LÓGICA ORIGINAL DE PROCESAMIENTO DE CALENDARIO -----


      // ----- INICIO DE TU LÓGICA ORIGINAL PARA FORMATEAR LA RESPUESTA DE CALENDARIO -----
      let replyCalendar = '';
      if (targetHourChile !== null) { // Si el usuario pidió una hora específica
        if (availableSlotsOutput.length > 0) { // Y esa hora específica está disponible
          replyCalendar = `¡Excelente! 🎉 Justo el ${availableSlotsOutput[0]} está libre para ti. ¡Qué buena suerte! Para asegurar tu cita,${getWhatsappDerivationSuffix(effectiveConfig.whatsappNumber)} 😉`;
        } else { // La hora específica no está disponible
          let specificTimeQuery = "";
          if(targetDateForDisplay) specificTimeQuery += `${new Intl.DateTimeFormat('es-CL', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Santiago' }).format(targetDateForDisplay)} `;
          specificTimeQuery += `a las ${targetHourChile.toString().padStart(2,'0')}:${targetMinuteChile.toString().padStart(2,'0')}`;
          replyCalendar = `¡Uy! Justo ${specificTimeQuery} no me quedan espacios. 😕 ¿Te gustaría que revise otro horario o quizás otro día?${getWhatsappContactMessage(effectiveConfig.whatsappNumber)}`;
        }
      } else if (availableSlotsOutput.length > 0) { // Búsqueda más general, y SÍ hay horas
        let intro = `¡Buenas noticias! 🎉 Encontré estas horitas disponibles`;
        // ... (resto de tu lógica para construir 'intro' y 'finalSuggestions')
        if (targetDateForDisplay) {
          if (isGenericNextWeekSearch) {
            intro += ` para la próxima semana (comenzando el ${new Intl.DateTimeFormat('es-CL', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Santiago' }).format(targetDateForDisplay)})`;
          } else {
            intro += ` para el ${new Intl.DateTimeFormat('es-CL', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Santiago' }).format(targetDateForDisplay)}`;
          }
        } else {
          intro += ` en los próximos días`;
        }
        if (timeOfDay === 'morning') intro += ' por la mañana';
        if (timeOfDay === 'afternoon') intro += ' por la tarde';
        intro += '. ¡A ver si alguna te acomoda! 🥳:';
        
        let finalSuggestions = [];
        if (!targetDateIdentifierForSlotFilter && !targetHourChile) { // Lógica de filtrado para búsqueda genérica
            const slotsByDay = {};
            for (const slot of availableSlotsOutput) {
                const dayPart = slot.split(',')[0] + ', ' + slot.split(',')[1]; // "lunes, 26 de mayo"
                if (!slotsByDay[dayPart]) slotsByDay[dayPart] = [];
                if (slotsByDay[dayPart].length < 2) { // Máximo 2 por día
                    slotsByDay[dayPart].push(slot);
                }
            }
            let count = 0;
            const sortedDays = Object.keys(slotsByDay).sort((a, b) => new Date(a.split(', ')[1] + " " + currentYearChile) - new Date(b.split(', ')[1] + " " + currentYearChile));

            for (const day of sortedDays) {
                if (count >= effectiveConfig.maxSuggestions) break;
                for(const slot of slotsByDay[day]){
                    if (count >= effectiveConfig.maxSuggestions) break;
                    finalSuggestions.push(slot);
                    count++;
                }
            }
        } else { 
            finalSuggestions = availableSlotsOutput.slice(0, effectiveConfig.maxSuggestions); 
        }

        replyCalendar = `${intro}\n- ${finalSuggestions.join('\n- ')}`;
        if (availableSlotsOutput.length > finalSuggestions.length && finalSuggestions.length > 0) {
          const remaining = availableSlotsOutput.length - finalSuggestions.length;
          if (remaining > 0) { replyCalendar += `\n\n(Y ${remaining} más... ¡para que tengas de dónde elegir! 😉)`; }
        }
        replyCalendar += `\n\nPara reservar alguna o si buscas otra opción,${getWhatsappDerivationSuffix(effectiveConfig.whatsappNumber)}`;

      } else { // No se encontraron horas disponibles en la búsqueda
        replyCalendar = '¡Pucha! 😔 Parece que no tengo horas libres';
        // ... (resto de tu lógica para este caso)
        if (targetDateForDisplay) {
          replyCalendar += ` para el ${new Intl.DateTimeFormat('es-CL', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Santiago' }).format(targetDateForDisplay)}`;
        } else if (isAnyNextWeekIndicator) { replyCalendar += ` para la próxima semana`; }
        if (timeOfDay === 'morning') replyCalendar += ' por la mañana'; if (timeOfDay === 'afternoon') replyCalendar += ' por la tarde';
        if (targetHourChile !== null && !targetDateForDisplay && !isAnyNextWeekIndicator) replyCalendar += ` a las ${targetHourChile.toString().padStart(2,'0')}:${targetMinuteChile.toString().padStart(2,'0')}`
        if (targetDateForDisplay || timeOfDay || targetHourChile || isAnyNextWeekIndicator) { replyCalendar += '.'; }
        else { replyCalendar += ` dentro de los próximos ${effectiveConfig.calendarQueryDays} días.`; }
        replyCalendar += ` ¿Te animas a que busquemos en otra fecha u horario?${getWhatsappContactMessage(effectiveConfig.whatsappNumber)} ¡Seguro te podemos ayudar!`;
      }
      // ----- FIN TU LÓGICA ORIGINAL PARA FORMATEAR LA RESPUESTA DE CALENDARIO -----

      console.log('✅ Respuesta generada (Calendario REAL):', replyCalendar);
      if (typeof logRigbotMessage === "function") { try { await logRigbotMessage({ role: "assistant", content: replyCalendar, sessionId: currentSessionId, ip: ipAddress, clientId: requestClientId }); } catch(e){console.error("Log Error:",e)} }
      return res.status(200).json({ response: replyCalendar });
    }

    // --- Rama de OpenAI (sin cambios) ---
    console.log('💡 Consulta normal, usando OpenAI para', requestClientId);
    let finalSystemPrompt = effectiveConfig.basePrompt;
    finalSystemPrompt = finalSystemPrompt.replace(/\$\{DAYS_TO_QUERY_CALENDAR\}/g, String(effectiveConfig.calendarQueryDays));
    finalSystemPrompt = finalSystemPrompt.replace(/\$\{MAX_DAYS_FOR_USER_REQUEST\}/g, String(effectiveConfig.calendarMaxUserRequestDays));
    if (effectiveConfig.whatsappNumber && effectiveConfig.whatsappNumber !== WHATSAPP_FALLBACK_PLACEHOLDER && String(effectiveConfig.whatsappNumber).trim() !== "") {
        finalSystemPrompt = finalSystemPrompt.replace(/\$\{whatsappNumber\}/g, String(effectiveConfig.whatsappNumber));
    } else {
        finalSystemPrompt = finalSystemPrompt.replace(/\$\{whatsappNumber\}/g, "nuestro principal canal de contacto telefónico o digital");
    }
    finalSystemPrompt = finalSystemPrompt.replace(/\$\{pricingInfo\}/g, String(effectiveConfig.pricingInfo));
    finalSystemPrompt = finalSystemPrompt.replace(/\$\{direccion\}/g, String(effectiveConfig.direccion));
    finalSystemPrompt = finalSystemPrompt.replace(/\$\{horario\}/g, String(effectiveConfig.horario));
    finalSystemPrompt = finalSystemPrompt.replace(/\$\{chiropracticVideoUrl\}/g, String(effectiveConfig.chiropracticVideoUrl));

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
    console.error(`❌ Error en Rigbot para clientId ${requestClientId}:`, error.message, error.stack);
    const errorForUser = 'Ocurrió un error inesperado en Rigbot. Por favor, intenta más tarde.';
    if (typeof logRigbotMessage === "function") { try { await logRigbotMessage({ role: "assistant", content: `Error interno: ${error.message}. UserMsg: ${errorForUser}`, sessionId: currentSessionId, ip: ipAddress, clientId: requestClientId }); } catch(e){console.error("Log Error:",e)} }
    return res.status(500).json({ 
        error: errorForUser, 
        details: process.env.NODE_ENV === 'development' ? error.message + (error.stack ? `\nStack: ${error.stack.substring(0,500)}...` : '') : undefined 
    });
  }
}