// rigbot-product/pages/api/chat.js
import { google } from 'googleapis';
import { getCalendarClient as getDefaultCalendarClient } from '@/lib/google';
import OpenAI from 'openai';
import { logRigbotMessage } from "@/lib/rigbotLog";
import { DEFAULT_SYSTEM_PROMPT_TEMPLATE } from '@/lib/defaultSystemPromptTemplate';
import { db } from '@/lib/firebase-admin';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const MODEL_FALLBACK = process.env.OPENAI_MODEL || 'gpt-4o';
const CHILE_UTC_OFFSET_HOURS = -4; 
const WHATSAPP_FALLBACK_PLACEHOLDER = "+56900000000";

const defaultConfig = { /* ... (sin cambios) ... */ 
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
  // --- Lógica de CORS y validación de método POST (sin cambios) ---
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
  const ipAddress = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null;
  const currentSessionId = providedSessionId || `session_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

  if (!db) { /* ... (manejo de error de db) ... */ 
      console.error("FATAL en chat.js: Firestore (db) NO DISPONIBLE.");
      return res.status(500).json({ error: 'Error interno crítico del servidor.' });
  }

  // --- VALIDACIÓN DE CLIENTID Y CLAVE (sin cambios) ---
  if (!requestClientId || typeof requestClientId !== 'string') { /* ... */ return res.status(400).json({ error: "Client ID no válido o no proporcionado." }); }
  let clientDocSnap;
  let clientConfigData;
  try {
    const clientDocRef = db.collection('clients').doc(requestClientId);
    clientDocSnap = await clientDocRef.get();
    if (!clientDocSnap.exists) { /* ... */ return res.status(403).json({ error: "Client ID no registrado. Acceso denegado." }); }
    clientConfigData = clientDocSnap.data();
  } catch (error) { /* ... */ return res.status(500).json({ error: "Error interno al verificar el cliente." }); }
  const expectedClave = clientConfigData?.clave;
  if (expectedClave && typeof expectedClave === 'string' && expectedClave.trim() !== "") {
    if (expectedClave !== incomingClave) { /* ... */ return res.status(401).json({ error: "Clave de API incorrecta para este Client ID." }); }
  }
  // --- FIN VALIDACIÓN ---

  if (!message) { /* ... (manejo de error de mensaje faltante) ... */ 
    const errorResponsePayload = { error: 'Falta el mensaje del usuario' };
    if (typeof logRigbotMessage === "function") { try { await logRigbotMessage({ role: "assistant", content: `Error: ${errorResponsePayload.error}`, sessionId: currentSessionId, ip: ipAddress, clientId: requestClientId }); } catch(e){console.error("Log Error:",e)} }
    return res.status(400).json(errorResponsePayload);
  }
  if (typeof logRigbotMessage === "function") { /* ... (tu logueo de mensaje de usuario) ... */ 
     try { await logRigbotMessage({ role: "user", content: message, sessionId: currentSessionId, ip: ipAddress, clientId: requestClientId }); } 
    catch (logErr) { console.error("Error al loguear mensaje de usuario en Firestore:", logErr); }
  }

  let effectiveConfig = { ...defaultConfig };
  if (clientConfigData) { /* ... (tu lógica para poblar effectiveConfig) ... */ 
    effectiveConfig = { ...defaultConfig, ...clientConfigData };
    effectiveConfig.calendarQueryDays = Number(clientConfigData.calendarQueryDays) || defaultConfig.calendarQueryDays;
    effectiveConfig.calendarMaxUserRequestDays = Number(clientConfigData.calendarMaxUserRequestDays) || defaultConfig.calendarMaxUserRequestDays;
    effectiveConfig.maxSuggestions = clientConfigData.maxSuggestions !== undefined ? Number(clientConfigData.maxSuggestions) : defaultConfig.maxSuggestions;
  }
  console.log("🧠 Configuración efectiva usada para clientId", requestClientId, ":", JSON.stringify(effectiveConfig, null, 2));
  
  // Funciones auxiliares para mensajes de WhatsApp
  const getWhatsappContactMessage = (contactNumber) => {
    const num = String(contactNumber || effectiveConfig.whatsappNumber).trim();
    if (num && num !== WHATSAPP_FALLBACK_PLACEHOLDER) {
      return ` Para más detalles o para agendar, conversemos por WhatsApp 👉 ${num}`;
    }
    return " Para más detalles o para agendar, por favor contáctanos a través de nuestros canales principales.";
  };
  const getWhatsappDerivationSuffix = (contactNumber) => {
    const num = String(contactNumber || effectiveConfig.whatsappNumber).trim();
    if (num && num !== WHATSAPP_FALLBACK_PLACEHOLDER) {
      return ` ¡Escríbenos por WhatsApp al 👉 ${num}!`;
    }
    return " ¡Contáctanos para coordinar!";
  };


  try {
    console.log(`📨 Mensaje ("${message}") recibido para ${requestClientId}`);
    const lowerMessage = message.toLowerCase();
    const calendarKeywords = [ /* ... tus keywords ... */ ];
    const isCalendarQuery = calendarKeywords.some(keyword => lowerMessage.includes(keyword));

    if (isCalendarQuery) {
      console.log(`⏳ Detectada consulta de calendario para ${requestClientId}`);
      let calendar;

      // ----- LÓGICA PARA USAR CALENDARIO DEL CLIENTE O DEFAULT (sin cambios) -----
      if (clientConfigData && clientConfigData.googleCalendarConnected && clientConfigData.googleCalendarTokens) {
        console.log(`INFO: Cliente ${requestClientId} tiene Google Calendar conectado. Email: ${clientConfigData.googleCalendarEmail || 'No disponible en config'}. Intentando usar sus tokens.`);
        try {
          const oauth2Client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);
          oauth2Client.setCredentials(clientConfigData.googleCalendarTokens);
          if (clientConfigData.googleCalendarTokens.refresh_token && clientConfigData.googleCalendarTokens.expiry_date && new Date().getTime() > (clientConfigData.googleCalendarTokens.expiry_date - 5 * 60 * 1000)) {
            console.log(`INFO: Access token para ${requestClientId} (Email: ${clientConfigData.googleCalendarEmail}) expirado o por expirar. Intentando refrescar...`);
            try {
                const { credentials } = await oauth2Client.refreshAccessToken();
                oauth2Client.setCredentials(credentials);
                await db.collection("clients").doc(requestClientId).set({ googleCalendarTokens: credentials, googleCalendarLastSync: new Date().toISOString(), googleCalendarError: null },{ merge: true });
                console.log(`INFO: Access token refrescado y actualizado en Firestore para ${requestClientId}.`);
                clientConfigData.googleCalendarTokens = credentials;
            } catch (refreshError) {
                console.error(`ERROR: No se pudo refrescar el access token para ${requestClientId} (Email: ${clientConfigData.googleCalendarEmail}):`, refreshError.message);
                await db.collection("clients").doc(requestClientId).set({ googleCalendarConnected: false, googleCalendarError: `Error al refrescar token: ${refreshError.message}. Por favor, reconecta tu calendario.`, googleCalendarTokens: null },{ merge: true });
                calendar = await getDefaultCalendarClient();
                console.warn(`WARN: Calendario desconectado para ${requestClientId}. Usando calendario por defecto.`);
            }
          }
          if (calendar === undefined) { 
            calendar = google.calendar({ version: 'v3', auth: oauth2Client });
            console.log(`INFO: Usando Google Calendar del cliente ${requestClientId} (Email: ${clientConfigData.googleCalendarEmail || 'N/A'})`);
          }
        } catch (oauthError) {
          console.error(`ERROR: No se pudo crear cliente OAuth2 para ${requestClientId}:`, oauthError.message);
          calendar = await getDefaultCalendarClient();
        }
      } else {
        console.log(`INFO: Cliente ${requestClientId} no tiene Google Calendar conectado. Usando calendario por defecto.`);
        calendar = await getDefaultCalendarClient();
      }
      if (!calendar || typeof calendar.events?.list !== 'function') { /* ... (manejo de error de calendario no disponible) ... */ }
      // ----- FIN LÓGICA DE SELECCIÓN DE CALENDARIO -----
      
      const serverNowUtc = new Date(); // Momento actual en UTC
      let targetDateForDisplay = null;
      let targetDateIdentifierForSlotFilter = null; // YYYY-MM-DD en zona Chile
      let targetHourChile = null;
      let targetMinuteChile = 0;
      let timeOfDay = null; // 'morning', 'afternoon'
      let isGenericNextWeekSearch = false;

      // --- AJUSTE IMPORTANTE: Definición de refDateForTargetCalc ---
      // Queremos el inicio del día de HOY en Chile, pero representado en UTC.
      const nowInChile = new Date(serverNowUtc.toLocaleString("en-US", { timeZone: "America/Santiago" }));
      const refDateForTargetCalc = new Date(Date.UTC(nowInChile.getFullYear(), nowInChile.getMonth(), nowInChile.getDate(), 0 - CHILE_UTC_OFFSET_HOURS, 0, 0, 0));
      // Este refDateForTargetCalc es las 00:00 de HOY en Chile, pero como objeto Date UTC.
      // Ejemplo: Si hoy es Miércoles 28 de Mayo 15:00 Chile (-04:00),
      // nowInChile será Miércoles 28 de Mayo 15:00:00 (zona Chile)
      // refDateForTargetCalc será Miércoles 28 de Mayo 00:00:00 (zona Chile) = Miércoles 28 de Mayo 04:00:00 UTC.
      console.log(`DEBUG: serverNowUtc: ${serverNowUtc.toISOString()}, nowInChile: ${nowInChile.toISOString()}, refDateForTargetCalc (Hoy 00:00 Chile en UTC): ${refDateForTargetCalc.toISOString()}`);
      
      const actualCurrentDayOfWeekInChile = new Date(refDateForTargetCalc.toLocaleString("en-US", { timeZone: "America/Santiago" })).getDay(); // 0 (Dom) - 6 (Sab) en Chile
      console.log(`DEBUG: actualCurrentDayOfWeekInChile (0=Dom, 1=Lun): ${actualCurrentDayOfWeekInChile}`);

      // --- Lógica de Parseo de Fechas del Usuario (tu lógica original, con pequeños ajustes y logs) ---
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
        targetDateForDisplay = new Date(refDateForTargetCalc); // Inicio del día de HOY en Chile (en UTC)
      } else if (lowerMessage.includes('mañana') && !lowerMessage.includes('pasado mañana')) {
        targetDateForDisplay = new Date(refDateForTargetCalc);
        targetDateForDisplay.setUTCDate(targetDateForTargetCalc.getUTCDate() + 1); // Inicio del día de MAÑANA en Chile (en UTC)
      } else if (specificDayKeywordIndex !== -1) {
          targetDateForDisplay = new Date(refDateForTargetCalc);
          let daysToAdd = specificDayKeywordIndex - actualCurrentDayOfWeekInChile;
          if (daysToAdd < 0) { daysToAdd += 7; } // Si el día ya pasó esta semana, ir a la siguiente
          // Si pide "próximo X" y X es hoy o en los próximos días, o si pide "X de la próxima semana"
          if ((isAnyNextWeekIndicator && daysToAdd < 7) || (daysToAdd === 0 && isProximoWordQuery && specificDayKeywordIndex === actualCurrentDayOfWeekInChile)) {
             daysToAdd += 7; 
          } else if (daysToAdd === 0 && !isProximoWordQuery) { // Si pide "X" y X es hoy, y no es "próximo X"
            // Si es muy tarde hoy, buscar para la próxima semana
            const serverNowChileHour = new Date(serverNowUtc.toLocaleString("en-US", {timeZone: "America/Santiago"})).getHours();
            if (serverNowChileHour >= 19) { // Asumiendo que después de las 19h ya no se agenda para hoy
                daysToAdd += 7;
            }
          }
          targetDateForDisplay.setUTCDate(targetDateForTargetCalc.getUTCDate() + daysToAdd);
      } else if (isAnyNextWeekIndicator) { // "la próxima semana" o "semana que viene"
          targetDateForDisplay = new Date(refDateForTargetCalc);
          let daysUntilNextMonday = (1 - actualCurrentDayOfWeekInChile + 7) % 7;
          if (daysUntilNextMonday === 0 && actualCurrentDayOfWeekInChile === 1) daysUntilNextMonday = 7; // Si hoy es Lunes y pide "próxima semana" sin especificar día
          targetDateForDisplay.setUTCDate(targetDateForTargetCalc.getUTCDate() + daysUntilNextMonday);
          isGenericNextWeekSearch = true;
      }
      // Si no se especificó día, targetDateForDisplay será null, y la búsqueda comenzará desde "hoy" (refDateForTargetCalc)

      if (targetDateForDisplay) { /* ... (tu lógica de validación de fecha futura y mensaje) ... */ }
            
      targetDateIdentifierForSlotFilter = (targetDateForDisplay && !isGenericNextWeekSearch) ? getDayIdentifier(targetDateForDisplay, 'America/Santiago') : null;
      console.log(`DEBUG: targetDateForDisplay (UTC): ${targetDateForDisplay ? targetDateForDisplay.toISOString() : 'No especificado (desde hoy)'}`);
      console.log(`DEBUG: targetDateIdentifierForSlotFilter (Chile YYYY-MM-DD): ${targetDateIdentifierForSlotFilter}`);
            
      const timeMatch = lowerMessage.match(/(\d{1,2})\s*(:(00|30|15|45))?\s*(pm|am|h|hr|hrs)?/i);
      if (timeMatch) { /* ... (tu lógica de parseo de hora, sin cambios) ... */ }

      if (!targetHourChile && !isGenericNextWeekSearch && targetDateForDisplay && getDayIdentifier(targetDateForDisplay, 'America/Santiago') !== getDayIdentifier(refDateForTargetCalc, 'America/Santiago')) {
        // Si se especificó un día futuro (que no es hoy) pero no una hora, buscar en todo ese día
        timeOfDay = null; // No filtrar por mañana/tarde
      } else if (!targetHourChile && !targetDateIdentifierForSlotFilter) { // Búsqueda genérica desde hoy o "próxima semana genérica"
        if (lowerMessage.includes('tarde')) timeOfDay = 'afternoon';
        else if (lowerMessage.includes('mañana') && !isProximoWordQuery && !(isAnyNextWeekIndicator && specificDayKeywordIndex === -1)) timeOfDay = 'morning'; // "mañana" como franja si no es "mañana [día]"
      }
      if(timeOfDay) console.log(`DEBUG: timeOfDay (franja horaria solicitada): ${timeOfDay}`);
      
      const WORKING_HOURS_CHILE_NUMERIC = [10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5, 14, 14.5, 15, 15.5, 16, 16.5, 17, 17.5, 18, 18.5, 19, 19.5];
      if (targetHourChile !== null) { /* ... (tu validación de hora dentro de horario de atención) ... */ }
      // --- Fin Lógica de Parseo de Fechas ---

      let calendarQueryStartUtc = targetDateForDisplay ? new Date(targetDateForDisplay.getTime()) : new Date(refDateForTargetCalc.getTime());
      // Si se busca "mañana" o un día específico, timeMin debe ser el inicio de ESE día en UTC.
      // Si es una búsqueda genérica sin fecha (targetDateForDisplay es null), empieza desde refDateForTargetCalc (hoy 00:00 Chile UTC).
      // Si targetDateForDisplay es, por ejemplo, Jueves 29 Mayo 04:00 UTC (00:00 Chile), está bien.

      // Asegurarse que calendarQueryStartUtc no sea en el pasado si no se especificó una fecha.
      // Y que al menos empiece desde la hora actual + un pequeño buffer si es para hoy.
      const nowUtcWithBuffer = new Date(serverNowUtc.getTime() + 5 * 60 * 1000); // Ahora + 5 minutos
      if (getDayIdentifier(calendarQueryStartUtc, 'UTC') === getDayIdentifier(serverNowUtc, 'UTC') && calendarQueryStartUtc < nowUtcWithBuffer) {
          calendarQueryStartUtc = nowUtcWithBuffer;
          console.log(`DEBUG: Ajustando calendarQueryStartUtc para hoy a la hora actual + buffer: ${calendarQueryStartUtc.toISOString()}`);
      }


      const calendarQueryEndUtc = new Date(calendarQueryStartUtc);
      // Si se busca un día específico (targetDateIdentifierForSlotFilter no es null), 
      // el rango de búsqueda de Google Calendar debería ser solo para ese día.
      // Si es una búsqueda genérica, se usa effectiveConfig.calendarQueryDays.
      let queryDaysForGoogle = effectiveConfig.calendarQueryDays;
      if (targetDateIdentifierForSlotFilter && !isGenericNextWeekSearch) {
          queryDaysForGoogle = 1; // Buscar solo en el día específico
          calendarQueryEndUtc.setUTCDate(calendarQueryStartUtc.getUTCDate() + 1); // Hasta el final de ese día
          console.log(`DEBUG: Búsqueda para día específico, queryDaysForGoogle = 1`);
      } else {
          calendarQueryEndUtc.setUTCDate(calendarQueryStartUtc.getUTCDate() + effectiveConfig.calendarQueryDays);
      }
      
      console.log(`🗓️ Google Calendar Query para ${requestClientId} (Calendario: ${clientConfigData?.googleCalendarConnected && clientConfigData.googleCalendarEmail ? clientConfigData.googleCalendarEmail : (clientConfigData?.googleCalendarConnected ? 'Cliente (email no obtenido)' : 'Default')}): De ${calendarQueryStartUtc.toISOString()} a ${calendarQueryEndUtc.toISOString()}`);
      
      let googleResponse;
      try {
        googleResponse = await calendar.events.list({ /* ... (tu consulta a Google, sin cambios) ... */ });
      } catch (googleError) { /* ... (tu manejo de error de Google API, sin cambios) ... */ }
            
      const eventsFromGoogle = googleResponse?.data?.items || [];
      console.log(`INFO: Se obtuvieron ${eventsFromGoogle.length} eventos del calendario para ${requestClientId}.`);
      
      const busySlots = eventsFromGoogle.filter(e => e.status !== 'cancelled')
        .map(e => { /* ... (tu lógica de busySlots, sin cambios) ... */ }).filter(Boolean);

      const WORKING_HOURS_CHILE_STR = ['10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30', '14:00', '14:30', '15:00', '15:30', '16:00', '16:30', '17:00', '17:30', '18:00', '18:30', '19:00', '19:30'];
      const availableSlotsOutput = [];
      const processedDaysForGenericQuery = new Set();
      
      // --- AJUSTE IMPORTANTE para el bucle de días ---
      // La base para iterar los días debe ser el inicio del rango de consulta a Google Calendar
      let baseIterationDateDayUtcStart = new Date(calendarQueryStartUtc);
      // Asegurarse de que baseIterationDateDayUtcStart sea las 00:00 UTC del día de inicio de la consulta,
      // para que el bucle de días comience correctamente desde el primer día que consultamos a Google.
      baseIterationDateDayUtcStart.setUTCHours(0,0,0,0); // Esto podría no ser necesario si calendarQueryStartUtc ya está bien.
                                                       // Lo importante es que el bucle itere sobre los días correctos.

      // Si targetDateForDisplay está definido (ej. "mañana" o "viernes"), 
      // el bucle debería empezar desde ESE día.
      if (targetDateForDisplay) {
        baseIterationDateDayUtcStart = new Date(targetDateForDisplay); 
        // Asegurarse de que sea el inicio del día en UTC para la lógica de iteración de días.
        // Pero las horas de Chile las calculamos con convertChileTimeToUtc.
        // Lo importante es que currentDayProcessingUtcStart represente el día correcto.
      } else {
        // Si no hay targetDateForDisplay, empezamos desde "hoy" (refDateForTargetCalc ya es hoy 00:00 Chile en UTC)
        baseIterationDateDayUtcStart = new Date(refDateForTargetCalc);
      }

      console.log(`DEBUG: Iniciando bucle de ${queryDaysForGoogle} días para ${requestClientId}. Base UTC REAL para iteración de días: ${baseIterationDateDayUtcStart.toISOString()}`);

      for (let i = 0; i < queryDaysForGoogle; i++) { // Usar queryDaysForGoogle
        const currentDayProcessingUtcStart = new Date(baseIterationDateDayUtcStart);
        currentDayProcessingUtcStart.setUTCDate(baseIterationDateDayUtcStart.getUTCDate() + i);
        
        console.log(`DEBUG: Procesando día ${i + 1}: ${getDayIdentifier(currentDayProcessingUtcStart, 'America/Santiago')}`);

        for (const timeChileStr of WORKING_HOURS_CHILE_STR) {
            const [hChile, mChile] = timeChileStr.split(':').map(Number);
            // ... (tu lógica de filtro de hora/franja horaria) ...
            if (targetHourChile !== null) {
              if (hChile !== targetHourChile || mChile !== targetMinuteChile) { continue; }
            } else if (timeOfDay && targetDateIdentifierForSlotFilter && getDayIdentifier(currentDayProcessingUtcStart, 'America/Santiago') === targetDateIdentifierForSlotFilter) {
              // Si se busca un día específico Y una franja (ej. "mañana por la tarde")
              if (timeOfDay === 'morning' && (hChile < 10 || hChile >= 14)) continue;
              if (timeOfDay === 'afternoon' && (hChile < 14 || hChile > 19 || (hChile === 19 && mChile > 30))) continue;
            } else if (timeOfDay && !targetDateIdentifierForSlotFilter && !isGenericNextWeekSearch) {
              // Si se busca una franja genérica (ej. "tienes algo por la tarde?") y no un día específico
              if (timeOfDay === 'morning' && (hChile < 10 || hChile >= 14)) continue;
              if (timeOfDay === 'afternoon' && (hChile < 14 || hChile > 19 || (hChile === 19 && mChile > 30))) continue;
            }


            const slotStartUtc = convertChileTimeToUtc(currentDayProcessingUtcStart, hChile, mChile);
            if (isNaN(slotStartUtc.getTime())) { console.warn("SlotStartUtc inválido:", currentDayProcessingUtcStart, hChile, mChile); continue; }
            
            // Ajuste: slightlyFutureServerNowUtc es el "ahora" + buffer.
            // Solo debemos comparar con esto si el currentDayProcessingUtcStart es HOY en Chile.
            const isTodayInChileLoop = getDayIdentifier(currentDayProcessingUtcStart, 'America/Santiago') === getDayIdentifier(serverNowUtc, 'America/Santiago');
            if (isTodayInChileLoop && slotStartUtc < nowUtcWithBuffer) {
              // console.log(`DEBUG: Slot ${timeChileStr} en ${getDayIdentifier(currentDayProcessingUtcStart, 'America/Santiago')} es pasado (${slotStartUtc.toISOString()} vs ${nowUtcWithBuffer.toISOString()}). Saltando.`);
              continue; 
            }
            // Si no es hoy, o si es hoy pero el slot es futuro, no lo saltamos por esta razón.

            // Si se busca un día específico (targetDateIdentifierForSlotFilter NO es null), 
            // y el día actual del bucle no es ese día, saltamos.
            if (targetDateIdentifierForSlotFilter && getDayIdentifier(currentDayProcessingUtcStart, 'America/Santiago') !== targetDateIdentifierForSlotFilter) {
                // console.log(`DEBUG: Día del bucle ${getDayIdentifier(currentDayProcessingUtcStart, 'America/Santiago')} no coincide con target ${targetDateIdentifierForSlotFilter}. Saltando día completo.`);
                break; // Salir del bucle de horas para este día, pasar al siguiente día.
            }
            
            const slotEndUtc = new Date(slotStartUtc.getTime() + 30 * 60 * 1000); // Asumiendo citas de 30 min
            
            const isBusy = busySlots.some(busy => slotStartUtc.getTime() < busy.end && slotEndUtc.getTime() > busy.start);
            
            if (!isBusy) {
              const formattedSlot = new Intl.DateTimeFormat('es-CL', {weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'America/Santiago'}).format(slotStartUtc);
              // ... (tu lógica para añadir a availableSlotsOutput y processedDaysForGenericQuery) ...
              if (!targetDateIdentifierForSlotFilter && !targetHourChile) { 
                  if (availableSlotsOutput.length < effectiveConfig.maxSuggestions * 2) { 
                    if (!processedDaysForGenericQuery.has(getDayIdentifier(slotStartUtc, 'America/Santiago')) || availableSlotsOutput.length < 2) {
                        availableSlotsOutput.push(formattedSlot); processedDaysForGenericQuery.add(getDayIdentifier(slotStartUtc, 'America/Santiago'));
                    } else if (Array.from(processedDaysForGenericQuery).length < 3 && availableSlotsOutput.filter(s => s.startsWith(new Intl.DateTimeFormat('es-CL', {weekday: 'long', timeZone: 'America/Santiago'}).format(slotStartUtc))).length < 2) { 
                        availableSlotsOutput.push(formattedSlot);
                    }
                  }
              } else { 
                availableSlotsOutput.push(formattedSlot);
              }
            }
        } // Fin bucle timeChileStr
        
        // Lógica de corte de bucle
        if (targetDateIdentifierForSlotFilter && getDayIdentifier(currentDayProcessingUtcStart, 'America/Santiago') === targetDateIdentifierForSlotFilter) {
            if (targetHourChile !== null || availableSlotsOutput.length >= effectiveConfig.maxSuggestions ) {
                console.log("DEBUG: Corte de bucle por día específico y hora/max suggestions alcanzado.");
                break; 
            }
        }
        if (availableSlotsOutput.length >= effectiveConfig.maxSuggestions && !targetDateIdentifierForSlotFilter && !targetHourChile && processedDaysForGenericQuery.size >=2) {
            console.log("DEBUG: Corte de bucle por búsqueda genérica y max suggestions/días alcanzado.");
            break;
        }
      } // Fin bucle i (días)
      console.log("DEBUG: availableSlotsOutput final:", availableSlotsOutput);
      // ----- FIN TU LÓGICA ORIGINAL DE PROCESAMIENTO DE CALENDARIO -----


      // ----- INICIO DE TU LÓGICA ORIGINAL PARA FORMATEAR LA RESPUESTA DE CALENDARIO (sin cambios) -----
      let replyCalendar = '';
      // ... (toda tu lógica para construir replyCalendar basada en availableSlotsOutput se mantiene igual) ...
      if (targetHourChile !== null) { 
        if (availableSlotsOutput.length > 0) {
          replyCalendar = `¡Excelente! 🎉 Justo el ${availableSlotsOutput[0]} está libre para ti. ¡Qué buena suerte! Para asegurar tu cita,${getWhatsappDerivationSuffix(effectiveConfig.whatsappNumber)} 😉`;
        } else { 
          let specificTimeQuery = "";
          if(targetDateForDisplay) specificTimeQuery += `${new Intl.DateTimeFormat('es-CL', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Santiago' }).format(targetDateForDisplay)} `;
          specificTimeQuery += `a las ${targetHourChile.toString().padStart(2,'0')}:${targetMinuteChile.toString().padStart(2,'0')}`;
          replyCalendar = `¡Uy! Justo ${specificTimeQuery} no me quedan espacios. 😕 ¿Te gustaría que revise otro horario o quizás otro día?${getWhatsappContactMessage(effectiveConfig.whatsappNumber)}`;
        }
      } else if (availableSlotsOutput.length > 0) {
        let intro = `¡Buenas noticias! 🎉 Encontré estas horitas disponibles`;
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
        if (!targetDateIdentifierForSlotFilter && !targetHourChile) {
            const slotsByDay = {};
            for (const slot of availableSlotsOutput) {
                const dayPart = slot.split(',')[0] + ', ' + slot.split(',')[1]; 
                if (!slotsByDay[dayPart]) slotsByDay[dayPart] = [];
                if (slotsByDay[dayPart].length < 2) { 
                    slotsByDay[dayPart].push(slot);
                }
            }
            let count = 0;
            const sortedDays = Object.keys(slotsByDay).sort((a, b) => {
                // Convertir "nombreMes día" a objeto Date para ordenar correctamente
                const dateA = new Date(a.split(', ')[1].replace(' de ', ' ') + " " + currentYearChile); // Asume año actual
                const dateB = new Date(b.split(', ')[1].replace(' de ', ' ') + " " + currentYearChile);
                return dateA - dateB;
            });

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
        if (availableSlotsOutput.length > finalSuggestions.length && finalSuggestions.length > 0 && finalSuggestions.length >= effectiveConfig.maxSuggestions) {
          const remaining = availableSlotsOutput.length - finalSuggestions.length;
          if (remaining > 0) { replyCalendar += `\n\n(Y ${remaining} más... ¡para que tengas de dónde elegir! 😉)`; }
        }
        replyCalendar += `\n\nPara reservar alguna o si buscas otra opción,${getWhatsappDerivationSuffix(effectiveConfig.whatsappNumber)}`;

      } else { 
        replyCalendar = '¡Pucha! 😔 Parece que no tengo horas libres';
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
    } // Fin de if (isCalendarQuery)

    // --- Rama de OpenAI (sin cambios) ---
    console.log('💡 Consulta normal, usando OpenAI para', requestClientId);
    let finalSystemPrompt = effectiveConfig.basePrompt;
    // ... (reemplazo de placeholders) ...
    finalSystemPrompt = finalSystemPrompt.replace(/\$\{DAYS_TO_QUERY_CALENDAR\}/g, String(effectiveConfig.calendarQueryDays));
    finalSystemPrompt = finalSystemPrompt.replace(/\$\{MAX_DAYS_FOR_USER_REQUEST\}/g, String(effectiveConfig.calendarMaxUserRequestDays));
    if (effectiveConfig.whatsappNumber && String(effectiveConfig.whatsappNumber).trim() !== "" && String(effectiveConfig.whatsappNumber) !== WHATSAPP_FALLBACK_PLACEHOLDER) {
        finalSystemPrompt = finalSystemPrompt.replace(/\$\{whatsappNumber\}/g, String(effectiveConfig.whatsappNumber));
    } else {
        finalSystemPrompt = finalSystemPrompt.replace(/\$\{whatsappNumber\}/g, "nuestro principal canal de contacto");
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