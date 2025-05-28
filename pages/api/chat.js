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

function convertChileTimeToUtc(baseDateUtcDay, chileHour, chileMinute) {
  let utcHour = chileHour - CHILE_UTC_OFFSET_HOURS;
  const newUtcDate = new Date(baseDateUtcDay.getTime());
  newUtcDate.setUTCHours(utcHour, chileMinute, 0, 0);
  return newUtcDate;
}

function getDayIdentifier(dateObj, timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    timeZone: timeZone
  }).format(dateObj);
}

export default async function handler(req, res) {
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
    else { return res.status(403).json({ error: "Origen no permitido por CORS." }); }
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const { message, sessionId: providedSessionId, clientId: bodyClientId, clave: incomingClave } = req.body || {};
  const requestClientId = bodyClientId;
  const ipAddress = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null;
  const currentSessionId = providedSessionId || `session_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

  if (!db) {
    console.error("FATAL en chat.js: Firestore (db) NO DISPONIBLE.");
    return res.status(500).json({ error: 'Error interno crítico del servidor.' });
  }

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
      if (typeof logRigbotMessage === "function") { try { await logRigbotMessage({ role: "system", content: `Intento de acceso con clave incorrecta. UserMsg: ${message}`, sessionId: currentSessionId, ip: ipAddress, clientId: requestClientId }); } catch (e) { console.error("Log Error:", e) } }
      return res.status(401).json({ error: "Clave de API incorrecta para este Client ID." });
    }
  }

  if (!message) {
    const errorResponsePayload = { error: 'Falta el mensaje del usuario' };
    if (typeof logRigbotMessage === "function") { try { await logRigbotMessage({ role: "assistant", content: `Error: ${errorResponsePayload.error}`, sessionId: currentSessionId, ip: ipAddress, clientId: requestClientId }); } catch (e) { console.error("Log Error:", e) } }
    return res.status(400).json(errorResponsePayload);
  }
  if (typeof logRigbotMessage === "function") {
    try { await logRigbotMessage({ role: "user", content: message, sessionId: currentSessionId, ip: ipAddress, clientId: requestClientId }); }
    catch (logErr) { console.error("Error al loguear mensaje de usuario en Firestore:", logErr); }
  }

  let effectiveConfig = { ...defaultConfig };
  if (clientConfigData) {
    console.log("INFO: Datos crudos de config del cliente desde Firestore:", JSON.stringify(clientConfigData, null, 2));
    effectiveConfig = { ...defaultConfig, ...clientConfigData };
    effectiveConfig.calendarQueryDays = Number(clientConfigData.calendarQueryDays) || defaultConfig.calendarQueryDays;
    effectiveConfig.calendarMaxUserRequestDays = Number(clientConfigData.calendarMaxUserRequestDays) || defaultConfig.calendarMaxUserRequestDays;
    effectiveConfig.maxSuggestions = clientConfigData.maxSuggestions !== undefined ? Number(clientConfigData.maxSuggestions) : defaultConfig.maxSuggestions;
  }
  console.log("🧠 Configuración efectiva usada para clientId", requestClientId, ":", JSON.stringify(effectiveConfig, null, 2));

  const getWhatsappContactMessage = (contactNumber) => {
    const num = String(contactNumber || effectiveConfig.whatsappNumber).trim();
    if (num && num !== WHATSAPP_FALLBACK_PLACEHOLDER && num !== "") {
      return ` Para más detalles o para agendar, conversemos por WhatsApp 👉 ${num}`;
    }
    return " Para más detalles o para agendar, por favor contáctanos a través de nuestros canales principales.";
  };
  const getWhatsappDerivationSuffix = (contactNumber) => {
    const num = String(contactNumber || effectiveConfig.whatsappNumber).trim();
    if (num && num !== WHATSAPP_FALLBACK_PLACEHOLDER && num !== "") {
      return ` ¡Escríbenos por WhatsApp al 👉 ${num}!`;
    }
    return " ¡Contáctanos para coordinar!";
  };

  try {
    console.log(`📨 Mensaje ("${message}") recibido para ${requestClientId}`);
    const lowerMessage = message.toLowerCase();
    const calendarKeywords = ['hora', 'turno', 'disponibilidad', 'agenda', 'cuando', 'horario', 'disponible', 'libre', 'atiendes', 'ver', 'revisar', 'chequear', 'consultar', 'lunes', 'martes', 'miercoles', 'miércoles', 'jueves', 'viernes', 'sabado', 'sábado', 'domingo', 'hoy', 'mañana', 'tarde', 'a las', 'para el', 'tienes algo', 'hay espacio', 'agendar', 'agendamiento', 'proxima semana', 'próxima semana', 'prixima semana', 'procsima semana', 'proxima semama', 'proximo', 'próximo', 'priximo', 'procsimo'];
    const isCalendarQuery = calendarKeywords.some(keyword => lowerMessage.includes(keyword));

    if (isCalendarQuery) {
      console.log(`⏳ Detectada consulta de calendario para ${requestClientId}`);
      let calendar;

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
              await db.collection("clients").doc(requestClientId).set({ googleCalendarTokens: credentials, googleCalendarLastSync: new Date().toISOString(), googleCalendarError: null }, { merge: true });
              console.log(`INFO: Access token refrescado y actualizado en Firestore para ${requestClientId}.`);
              clientConfigData.googleCalendarTokens = credentials;
            } catch (refreshError) {
              console.error(`ERROR: No se pudo refrescar el access token para ${requestClientId} (Email: ${clientConfigData.googleCalendarEmail}):`, refreshError.message);
              await db.collection("clients").doc(requestClientId).set({ googleCalendarConnected: false, googleCalendarError: `Error al refrescar token: ${refreshError.message}. Por favor, reconecta tu calendario.`, googleCalendarTokens: null }, { merge: true });
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
        console.log(`INFO: Cliente ${requestClientId} no tiene Google Calendar conectado o faltan tokens. Usando calendario por defecto.`);
        calendar = await getDefaultCalendarClient();
      }
      if (!calendar || typeof calendar.events?.list !== 'function') {
        const errorMsg = "Lo siento, estoy teniendo problemas para acceder a la información de horarios en este momento. Por favor, intenta más tarde.";
        if (typeof logRigbotMessage === "function") { try { await logRigbotMessage({ role: "assistant", content: errorMsg, sessionId: currentSessionId, ip: ipAddress, clientId: requestClientId }); } catch (e) { console.error("Log Error:", e) } }
        return res.status(503).json({ response: errorMsg });
      }

      const serverNowUtc = new Date();
      let targetDateForDisplay = null;
      let targetDateIdentifierForSlotFilter = null;
      let targetHourChile = null;
      let targetMinuteChile = 0;
      let timeOfDay = null;
      let isGenericNextWeekSearch = false;

      const nowInChileLocaleString = serverNowUtc.toLocaleString("en-US", { timeZone: "America/Santiago" });
      const nowInChileDateObject = new Date(nowInChileLocaleString);
      const refDateForTargetCalc = new Date(Date.UTC(nowInChileDateObject.getFullYear(), nowInChileDateObject.getMonth(), nowInChileDateObject.getDate(), 0 - CHILE_UTC_OFFSET_HOURS, 0, 0, 0));
      const actualCurrentDayOfWeekInChile = new Date(refDateForTargetCalc.toLocaleString("en-US", {timeZone: "America/Santiago"})).getDay();
      
      console.log(`DEBUG CAL: ---- Inicio de Parseo de Fechas para "${message}" ----`);
      console.log(`DEBUG CAL: serverNowUtc: ${serverNowUtc.toISOString()}`);
      console.log(`DEBUG CAL: nowInChile (para obtener Y/M/D en Chile): ${nowInChileDateObject.toISOString()}`);
      console.log(`DEBUG CAL: refDateForTargetCalc (Hoy 00:00 Chile, en UTC): ${refDateForTargetCalc.toISOString()}`);
      console.log(`DEBUG CAL: actualCurrentDayOfWeekInChile (0=Dom, 1=Lun): ${actualCurrentDayOfWeekInChile}`);

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
        targetDateForDisplay = new Date(refDateForTargetCalc.getTime());
      } else if (lowerMessage.includes('mañana') && !lowerMessage.includes('pasado mañana')) {
        targetDateForDisplay = new Date(refDateForTargetCalc.getTime());
        targetDateForDisplay.setUTCDate(targetDateForDisplay.getUTCDate() + 1);
      } else if (specificDayKeywordIndex !== -1) {
          targetDateForDisplay = new Date(refDateForTargetCalc.getTime());
          let daysToAdd = specificDayKeywordIndex - actualCurrentDayOfWeekInChile;
          if (daysToAdd < 0 || (daysToAdd === 0 && isProximoWordQuery && specificDayKeywordIndex === actualCurrentDayOfWeekInChile)) { 
             daysToAdd += 7; 
          } else if (daysToAdd === 0 && !isProximoWordQuery) {
            const serverNowChileHour = nowInChileDateObject.getHours();
            if (serverNowChileHour >= 19) { daysToAdd += 7; }
          }
          targetDateForDisplay.setUTCDate(targetDateForTargetCalc.getUTCDate() + daysToAdd);
      } else if (isAnyNextWeekIndicator) { 
          targetDateForDisplay = new Date(refDateForTargetCalc.getTime());
          let daysUntilNextMonday = (1 - actualCurrentDayOfWeekInChile + 7) % 7;
          if (daysUntilNextMonday === 0 && actualCurrentDayOfWeekInChile === 1) daysUntilNextMonday = 7;
          targetDateForDisplay.setUTCDate(targetDateForTargetCalc.getUTCDate() + daysUntilNextMonday);
          isGenericNextWeekSearch = true;
      }

      if (targetDateForDisplay) {
        console.log(`DEBUG CAL: 🎯 Fecha Objetivo (Display) para ${requestClientId}: ${new Intl.DateTimeFormat('es-CL', { dateStyle: 'full', timeZone: 'America/Santiago' }).format(targetDateForDisplay)} (UTC: ${targetDateForDisplay.toISOString()})`);
        const futureLimitCheckDate = new Date(refDateForTargetCalc.getTime());
        futureLimitCheckDate.setUTCDate(futureLimitCheckDate.getUTCDate() + effectiveConfig.calendarMaxUserRequestDays);
        if (targetDateForDisplay >= futureLimitCheckDate) {
          const formattedDateAsked = new Intl.DateTimeFormat('es-CL', { dateStyle: 'long', timeZone: 'America/Santiago' }).format(targetDateForDisplay);
          let reply = `¡Entiendo que buscas para el ${formattedDateAsked}! 😊 Por ahora, mi calendario mental solo llega hasta unos ${effectiveConfig.calendarMaxUserRequestDays} días en el futuro.${getWhatsappContactMessage(effectiveConfig.whatsappNumber)} y mis colegas humanos te ayudarán con gusto.`;
          if (typeof logRigbotMessage === "function") { try { await logRigbotMessage({ role: "assistant", content: reply, sessionId: currentSessionId, ip: ipAddress, clientId: requestClientId }); } catch(e){console.error("Log Error:",e)} }
          return res.status(200).json({ response: reply });
        }
      } else {
        console.log(`DEBUG CAL: 🎯 Búsqueda genérica, targetDateForDisplay no establecido explícitamente.`);
      }
            
      targetDateIdentifierForSlotFilter = (targetDateForDisplay && !isGenericNextWeekSearch) ? getDayIdentifier(targetDateForDisplay, 'America/Santiago') : null;
      console.log(`DEBUG CAL: targetDateIdentifierForSlotFilter (YYYY-MM-DD Chile): ${targetDateIdentifierForSlotFilter}`);
            
      const timeMatch = lowerMessage.match(/(\d{1,2})\s*(:(00|30|15|45))?\s*(pm|am|h|hr|hrs)?/i);
      if (timeMatch) { 
        let hour = parseInt(timeMatch[1], 10);
        targetMinuteChile = timeMatch[3] ? parseInt(timeMatch[3], 10) : 0;
        const isPm = timeMatch[4] && timeMatch[4].toLowerCase() === 'pm';
        const isAm = timeMatch[4] && timeMatch[4].toLowerCase() === 'am';
        if (isPm && hour >= 1 && hour <= 11) hour += 12;
        if (isAm && hour === 12) hour = 0; 
        targetHourChile = hour;
        if (targetMinuteChile > 0 && targetMinuteChile < 15) targetMinuteChile = 0;
        else if (targetMinuteChile > 15 && targetMinuteChile < 30) targetMinuteChile = 15; 
        else if (targetMinuteChile > 30 && targetMinuteChile < 45) targetMinuteChile = 30;
        else if (targetMinuteChile > 45 && targetMinuteChile < 60) targetMinuteChile = 45; 
        console.log(`DEBUG CAL: ⏰ Hora objetivo (Chile) para ${requestClientId}: ${targetHourChile}:${targetMinuteChile.toString().padStart(2,'0')}`);
       }

      if (!targetHourChile) { 
        if (targetDateIdentifierForSlotFilter) { 
            if (lowerMessage.includes('tarde')) timeOfDay = 'afternoon';
            else if (lowerMessage.includes('mañana') && 
                     (lowerMessage.includes(dayKeywordsList.find(d=>d.index === new Date(targetDateForDisplay.toLocaleString("en-US", {timeZone: "America/Santiago"})).getDay())?.keyword || 'impossible_match') || 
                     (targetDateForDisplay && targetDateForDisplay > refDateForTargetCalc) )) { // Asegurar que no sea "mañana" si es una búsqueda de "hoy por la mañana"
                timeOfDay = 'morning';
            }
        } else if (!isGenericNextWeekSearch) { 
            if (lowerMessage.includes('tarde')) timeOfDay = 'afternoon';
            else if (lowerMessage.includes('mañana')) timeOfDay = 'morning';
        }
      }
      if(timeOfDay) console.log(`DEBUG CAL: timeOfDay (franja horaria solicitada): ${timeOfDay}`);
      
      const WORKING_HOURS_CHILE_NUMERIC = [10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5, 14, 14.5, 15, 15.5, 16, 16.5, 17, 17.5, 18, 18.5, 19, 19.5];
      if (targetHourChile !== null) { 
        const requestedTimeNumeric = targetHourChile + (targetMinuteChile / 60);
        if (!WORKING_HOURS_CHILE_NUMERIC.includes(requestedTimeNumeric) || requestedTimeNumeric < 10 || requestedTimeNumeric > 19.5) {
          let replyPreamble = `¡Ojo! 👀 Parece que las ${targetHourChile.toString().padStart(2,'0')}:${targetMinuteChile.toString().padStart(2,'0')}`;
          if (targetDateForDisplay) {
            replyPreamble = `¡Ojo! 👀 Parece que el ${new Intl.DateTimeFormat('es-CL', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Santiago' }).format(targetDateForDisplay)} a las ${targetHourChile.toString().padStart(2,'0')}:${targetMinuteChile.toString().padStart(2,'0')}`;
          }
          let reply = `${replyPreamble} está fuera de nuestro horario de atención (${effectiveConfig.horario}). ¿Te gustaría buscar dentro de ese rango?${getWhatsappContactMessage(effectiveConfig.whatsappNumber)}`;
          if (typeof logRigbotMessage === "function") { try { await logRigbotMessage({ role: "assistant", content: reply, sessionId: currentSessionId, ip: ipAddress, clientId: requestClientId }); } catch(e){console.error("Log Error:",e)} }
          return res.status(200).json({ response: reply });
        }
      }
      
      let timeMinForQuery;
      const nowUtcWithBuffer = new Date(serverNowUtc.getTime() + 1 * 60 * 1000); 

      if (targetDateForDisplay) {
        timeMinForQuery = new Date(targetDateForDisplay.getTime()); 
        if (getDayIdentifier(targetDateForDisplay, 'America/Santiago') === getDayIdentifier(nowInChileDateObject, 'America/Santiago')) {
            if (timeMinForQuery < nowUtcWithBuffer) {
                timeMinForQuery = nowUtcWithBuffer;
                console.log(`DEBUG CAL: timeMinForQuery ajustado a 'ahora + buffer' porque es para hoy: ${timeMinForQuery.toISOString()}`);
            }
        }
      } else {
        timeMinForQuery = nowUtcWithBuffer;
        console.log(`DEBUG CAL: timeMinForQuery para búsqueda genérica: ${timeMinForQuery.toISOString()}`);
      }

      const timeMaxForQuery = new Date(timeMinForQuery.getTime());
      let actualQueryDays = effectiveConfig.calendarQueryDays;

      if (targetDateIdentifierForSlotFilter && !isGenericNextWeekSearch) {
          actualQueryDays = 1; 
          const endOfDayTargetInChile = new Date(timeMinForQuery.toLocaleString("en-US", {timeZone: "America/Santiago"}));
          endOfDayTargetInChile.setHours(23, 59, 59, 999); // Fin del día en Chile
          // Convertir este fin de día en Chile a UTC para timeMaxForQuery
          timeMaxForQuery.setTime(Date.UTC(
              endOfDayTargetInChile.getFullYear(), 
              endOfDayTargetInChile.getMonth(), 
              endOfDayTargetInChile.getDate(), 
              endOfDayTargetInChile.getHours() - CHILE_UTC_OFFSET_HOURS, // Convertir hora Chile a UTC
              endOfDayTargetInChile.getMinutes(), 
              endOfDayTargetInChile.getSeconds(), 
              endOfDayTargetInChile.getMilliseconds()
          ));
          console.log(`DEBUG CAL: Búsqueda para día específico. queryDaysForGoogle = 1. timeMaxForQuery (fin del día objetivo en UTC): ${timeMaxForQuery.toISOString()}`);
      } else {
          timeMaxForQuery.setUTCDate(timeMinForQuery.getUTCDate() + effectiveConfig.calendarQueryDays);
          console.log(`DEBUG CAL: Búsqueda genérica. queryDaysForGoogle = ${effectiveConfig.calendarQueryDays}`);
      }
      
      console.log(`🗓️ Google Calendar Query para ${requestClientId} ... De ${timeMinForQuery.toISOString()} a ${timeMaxForQuery.toISOString()}`);
      
      let googleResponse;
      try {
        googleResponse = await calendar.events.list({
            calendarId: 'primary',
            timeMin: timeMinForQuery.toISOString(),
            timeMax: timeMaxForQuery.toISOString(),
            singleEvents: true,
            orderBy: 'startTime',
            maxResults: 250 
        });
      } catch (googleError) { /* ... (tu manejo de error de Google API) ... */ }
            
      const eventsFromGoogle = googleResponse?.data?.items || [];
      console.log(`INFO: Se obtuvieron ${eventsFromGoogle.length} eventos del calendario para ${requestClientId}.`);
      if (eventsFromGoogle.length > 0) { console.log("DEBUG CAL: Eventos de Google (resumen):", JSON.stringify(eventsFromGoogle.map(e => ({summary: e.summary, start: e.start?.dateTime || e.start?.date, end: e.end?.dateTime || e.end?.date, status: e.status})), null, 2)); }
      
      const busySlots = eventsFromGoogle
        .filter(e => e.status !== 'cancelled')
        .map(e => {
            if (e.start?.dateTime && e.end?.dateTime) {
              return { start: new Date(e.start.dateTime).getTime(), end: new Date(e.end.dateTime).getTime() };
            } else if (e.start?.date && e.end?.date) { 
              const startDateAllDayUtc = new Date(e.start.date);
              const endDateAllDayUtc = new Date(e.end.date);
              return { start: startDateAllDayUtc.getTime(), end: endDateAllDayUtc.getTime() };
            }
            return null;
        }).filter(Boolean);
      if (busySlots.length > 0) { console.log("DEBUG CAL: Busy Slots calculados (timestamps UTC):", JSON.stringify(busySlots)); }

      const WORKING_HOURS_CHILE_STR = ['10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30', '14:00', '14:30', '15:00', '15:30', '16:00', '16:30', '17:00', '17:30', '18:00', '18:30', '19:00', '19:30'];
      const availableSlotsOutput = [];
      const processedDaysForGenericQuery = new Set();
      
      let iterationBaseDateUTC; 
      if (targetDateForDisplay) {
        iterationBaseDateUTC = new Date(targetDateForDisplay.getTime());
      } else {
        iterationBaseDateUTC = new Date(refDateForTargetCalc.getTime());
      }
      // iterationBaseDateUTC ya representa 00:00 Chile en UTC para el día de inicio.

      console.log(`DEBUG CAL: Iniciando bucle de slots. iterationBaseDateUTC (para el bucle): ${iterationBaseDateUTC.toISOString()}. Iterando ${actualQueryDays} dias.`);

      for (let i = 0; i < actualQueryDays; i++) {
        const currentDayBeingProcessedLoopBase = new Date(iterationBaseDateUTC.getTime());
        currentDayBeingProcessedLoopBase.setUTCDate(iterationBaseDateUTC.getUTCDate() + i);
        
        const currentDayIdentifierChile = getDayIdentifier(currentDayBeingProcessedLoopBase, 'America/Santiago');
        console.log(`DEBUG CAL: Procesando día ${i + 1}/${actualQueryDays}: ${currentDayIdentifierChile} (Base UTC del día: ${currentDayBeingProcessedLoopBase.toISOString()})`);

        if (targetDateIdentifierForSlotFilter && currentDayIdentifierChile !== targetDateIdentifierForSlotFilter) {
            console.log(`DEBUG CAL: Día del bucle ${currentDayIdentifierChile} no es el día objetivo ${targetDateIdentifierForSlotFilter}. Saltando.`);
            continue; 
        }

        for (const timeChileStr of WORKING_HOURS_CHILE_STR) {
            const [hChile, mChile] = timeChileStr.split(':').map(Number);
            
            if (targetHourChile !== null) {
              if (targetDateIdentifierForSlotFilter === currentDayIdentifierChile) {
                if (hChile !== targetHourChile || mChile !== targetMinuteChile) { continue; }
              } else if (targetDateIdentifierForSlotFilter) { 
                continue;
              }
            } 
            else if (timeOfDay) {
                if (targetDateIdentifierForSlotFilter === currentDayIdentifierChile || !targetDateIdentifierForSlotFilter) {
                    if (timeOfDay === 'morning' && (hChile < 10 || hChile >= 14)) continue;
                    if (timeOfDay === 'afternoon' && (hChile < 14 || hChile > 19 || (hChile === 19 && mChile > 30))) continue;
                }
            }

            const slotStartUtc = convertChileTimeToUtc(currentDayBeingProcessedLoopBase, hChile, mChile);
            if (isNaN(slotStartUtc.getTime())) { 
                console.warn(`DEBUG CAL: SlotStartUtc inválido para ${currentDayIdentifierChile} ${timeChileStr}`); 
                continue; 
            }
            
            if (slotStartUtc < nowUtcWithBuffer) {
              continue; 
            }
            
            const slotEndUtc = new Date(slotStartUtc.getTime() + 30 * 60 * 1000);
            const isBusy = busySlots.some(busy => slotStartUtc.getTime() < busy.end && slotEndUtc.getTime() > busy.start);
            
            // console.log(`DEBUG CAL: Evaluando Slot: ${currentDayIdentifierChile} ${timeChileStr} (UTC: ${slotStartUtc.toISOString()}), Ocupado: ${isBusy}`);

            if (!isBusy) {
              // console.log(`DEBUG CAL: Slot ${timeChileStr} (${currentDayIdentifierChile}) está LIBRE. Añadiendo.`);
              const formattedSlot = new Intl.DateTimeFormat('es-CL', {weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'America/Santiago'}).format(slotStartUtc);
              
              if (!targetDateIdentifierForSlotFilter && !targetHourChile) { 
                  if (availableSlotsOutput.length < effectiveConfig.maxSuggestions * 2) { 
                    const dayIdentifierForSlot = getDayIdentifier(slotStartUtc, 'America/Santiago');
                    if (!processedDaysForGenericQuery.has(dayIdentifierForSlot) || availableSlotsOutput.filter(s=>s.startsWith(new Intl.DateTimeFormat('es-CL', {weekday: 'long',day:'numeric', month:'long', timeZone: 'America/Santiago'}).format(slotStartUtc).split(',')[0] )).length < 2 ) { // Max 2 por día en búsqueda genérica
                        availableSlotsOutput.push(formattedSlot); 
                        processedDaysForGenericQuery.add(dayIdentifierForSlot);
                    }
                  }
              } else { 
                if (availableSlotsOutput.length < effectiveConfig.maxSuggestions * 2) { // Limitar también para búsquedas específicas
                    availableSlotsOutput.push(formattedSlot);
                }
              }
            }
        } 
        
        if (targetDateIdentifierForSlotFilter && currentDayIdentifierChile === targetDateIdentifierForSlotFilter) {
            if (targetHourChile !== null || availableSlotsOutput.length >= effectiveConfig.maxSuggestions ) {
                console.log("DEBUG CAL: Se procesó el día específico y se alcanzó el límite o se encontró hora exacta.");
                break; 
            }
        }
        if (availableSlotsOutput.length >= effectiveConfig.maxSuggestions && !targetDateIdentifierForSlotFilter && !targetHourChile && processedDaysForGenericQuery.size >=Math.ceil(effectiveConfig.maxSuggestions / 2) ) { // Cortar si tenemos suficientes sugerencias de al menos X días
             console.log(`DEBUG CAL: Límite de sugerencias alcanzado para búsqueda genérica.`);
            break;
        }
      } 
      console.log("DEBUG CAL: availableSlotsOutput ANTES de filtrar por maxSuggestions:", JSON.stringify(availableSlotsOutput));
      
      // Aplicar el límite de maxSuggestions a la salida final
      const finalAvailableSlots = availableSlotsOutput.slice(0, effectiveConfig.maxSuggestions);
      console.log("DEBUG CAL: finalAvailableSlots DESPUÉS de filtrar por maxSuggestions:", JSON.stringify(finalAvailableSlots));


      let replyCalendar = '';
      if (targetHourChile !== null) { 
        if (finalAvailableSlots.length > 0) { // Usar finalAvailableSlots
          replyCalendar = `¡Excelente! 🎉 Justo el ${finalAvailableSlots[0]} está libre para ti. ¡Qué buena suerte! Para asegurar tu cita,${getWhatsappDerivationSuffix(effectiveConfig.whatsappNumber)} 😉`;
        } else { 
          // ... (tu lógica de "hora no disponible")
        }
      } else if (finalAvailableSlots.length > 0) { // Usar finalAvailableSlots
        let intro = `¡Buenas noticias! 🎉 Encontré estas horitas disponibles`;
        // ... (tu lógica para intro) ...
        intro += '. ¡A ver si alguna te acomoda! 🥳:';
        
        replyCalendar = `${intro}\n- ${finalAvailableSlots.join('\n- ')}`;
        if (availableSlotsOutput.length > finalAvailableSlots.length && finalAvailableSlots.length > 0 && finalAvailableSlots.length >= effectiveConfig.maxSuggestions) {
          const remaining = availableSlotsOutput.length - finalAvailableSlots.length;
          if (remaining > 0) { replyCalendar += `\n\n(Y ${remaining} más... ¡para que tengas de dónde elegir! 😉)`; }
        }
        replyCalendar += `\n\nPara reservar alguna o si buscas otra opción,${getWhatsappDerivationSuffix(effectiveConfig.whatsappNumber)}`;
      } else { 
        // ... (tu lógica de "no hay horas disponibles")
      }

      console.log('✅ Respuesta generada (Calendario REAL):', replyCalendar);
      if (typeof logRigbotMessage === "function") { try { await logRigbotMessage({ role: "assistant", content: replyCalendar, sessionId: currentSessionId, ip: ipAddress, clientId: requestClientId }); } catch(e){console.error("Log Error:",e)} }
      return res.status(200).json({ response: replyCalendar });
    } // Fin de if (isCalendarQuery)

    console.log('💡 Consulta normal, usando OpenAI para', requestClientId);
    let finalSystemPrompt = effectiveConfig.basePrompt;
    // ... (reemplazo de placeholders sin cambios) ...
    return res.status(200).json({ response: "Respuesta de OpenAI (simulada para no gastar tokens)" }); // SIMULADO

  } catch (error) {
    console.error(`❌ Error en Rigbot para clientId ${requestClientId}:`, error.message, error.stack);
    // ... (tu manejo de error global sin cambios) ...
  }
}