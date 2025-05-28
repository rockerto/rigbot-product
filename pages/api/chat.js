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

// defaultConfig ahora se poblará principalmente desde Firestore,
// pero mantenemos estos como los absolutos defaults si ALGO falla o no está en Firestore.
const defaultConfig = {
  basePrompt: process.env.RIGBOT_PROMPT || DEFAULT_SYSTEM_PROMPT_TEMPLATE,
  calendarQueryDays: 7,
  calendarMaxUserRequestDays: 21,
  maxSuggestions: 5,
  whatsappNumber: process.env.RIGBOT_DEFAULT_WSP || WHATSAPP_FALLBACK_PLACEHOLDER,

};

// --- Tus funciones de utilidad de fecha del Prototipo Antiguo ---
function convertChileTimeToUtc(baseDateUtcDay, chileHour, chileMinute) {
  let utcHour = chileHour - CHILE_UTC_OFFSET_HOURS;
  // Asegurarse de clonar la fecha base para no mutarla directamente en bucles
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
// --- Fin funciones de utilidad ---

export default async function handler(req, res) {
  // --- Lógica de CORS y validación de método POST (Consistente) ---
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

  if (!db) { 
      console.error("FATAL en chat.js: Firestore (db) NO DISPONIBLE.");
      return res.status(500).json({ error: 'Error interno crítico del servidor.' });
  }

  // --- VALIDACIÓN DE CLIENTID Y CLAVE (Consistente) ---
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
    console.error(`API Chat: Error al verificar clientId '${requestClientId}' en Firestore:`, error.message);
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

  // Poblar effectiveConfig: tomar defaultConfig y sobrescribir con clientConfigData
  let effectiveConfig = { 
    ...defaultConfig, 
    ...(clientConfigData || {}) // Asegurar que clientConfigData sea un objeto
  };
  // Asegurar que los valores numéricos sean números y tengan fallbacks correctos
  effectiveConfig.calendarQueryDays = Number(clientConfigData?.calendarQueryDays) || defaultConfig.calendarQueryDays;
  effectiveConfig.calendarMaxUserRequestDays = Number(clientConfigData?.calendarMaxUserRequestDays) || defaultConfig.calendarMaxUserRequestDays;
  effectiveConfig.maxSuggestions = clientConfigData?.maxSuggestions !== undefined ? Number(clientConfigData.maxSuggestions) : defaultConfig.maxSuggestions;
  
  // Usar valores de defaultConfig para campos que podrían ser null o undefined en clientConfigData pero tienen un default global
  effectiveConfig.whatsappNumber = clientConfigData?.whatsappNumber || defaultConfig.whatsappNumber;
  effectiveConfig.pricingInfo = clientConfigData?.pricingInfo || defaultConfig.pricingInfo;
  effectiveConfig.direccion = clientConfigData?.direccion || defaultConfig.direccion;
  effectiveConfig.horario = clientConfigData?.horario || defaultConfig.horario;
  effectiveConfig.chiropracticVideoUrl = clientConfigData?.chiropracticVideoUrl || defaultConfig.chiropracticVideoUrl;
  effectiveConfig.telefono = clientConfigData?.telefono || defaultConfig.telefono;
  effectiveConfig.basePrompt = clientConfigData?.basePrompt || defaultConfig.basePrompt;


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
      let calendar; // Este será el cliente de Google Calendar a usar

      // ----- LÓGICA PARA USAR CALENDARIO DEL CLIENTE O DEFAULT (Consistente con respuesta #76) -----
      if (clientConfigData && clientConfigData.googleCalendarConnected && clientConfigData.googleCalendarTokens) {
        console.log(`INFO CAL: Cliente ${requestClientId} tiene Google Calendar conectado. Email: ${clientConfigData.googleCalendarEmail || 'No disponible'}. Intentando usar sus tokens.`);
        try {
          const oauth2Client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);
          oauth2Client.setCredentials(clientConfigData.googleCalendarTokens);
          if (clientConfigData.googleCalendarTokens.refresh_token && 
              clientConfigData.googleCalendarTokens.expiry_date &&
              new Date().getTime() > (clientConfigData.googleCalendarTokens.expiry_date - 5 * 60 * 1000)) {
            console.log(`INFO CAL: Access token para ${requestClientId} expirado o por expirar. Intentando refrescar...`);
            try {
                const { credentials } = await oauth2Client.refreshAccessToken();
                oauth2Client.setCredentials(credentials);
                await db.collection("clients").doc(requestClientId).set({ googleCalendarTokens: credentials, googleCalendarLastSync: new Date().toISOString(), googleCalendarError: null },{ merge: true });
                console.log(`INFO CAL: Access token refrescado y actualizado en Firestore para ${requestClientId}.`);
                clientConfigData.googleCalendarTokens = credentials;
            } catch (refreshError) {
                console.error(`ERROR CAL: No se pudo refrescar el access token para ${requestClientId}:`, refreshError.message);
                await db.collection("clients").doc(requestClientId).set({ googleCalendarConnected: false, googleCalendarError: `Error al refrescar token: ${refreshError.message}. Por favor, reconecta tu calendario.`, googleCalendarTokens: null },{ merge: true });
                calendar = await getDefaultCalendarClient(); // Fallback
                console.warn(`WARN CAL: Calendario desconectado para ${requestClientId}. Usando calendario por defecto.`);
            }
          }
          if (calendar === undefined) { 
            calendar = google.calendar({ version: 'v3', auth: oauth2Client });
            console.log(`INFO CAL: Usando Google Calendar del cliente ${requestClientId} (Email: ${clientConfigData.googleCalendarEmail || 'N/A'})`);
          }
        } catch (oauthError) {
          console.error(`ERROR CAL: No se pudo crear cliente OAuth2 para ${requestClientId}:`, oauthError.message);
          calendar = await getDefaultCalendarClient(); // Fallback
        }
      } else {
        console.log(`INFO CAL: Cliente ${requestClientId} no tiene Google Calendar conectado o faltan tokens. Usando calendario por defecto.`);
        calendar = await getDefaultCalendarClient();
      }
      if (!calendar || typeof calendar.events?.list !== 'function') { 
        const errorMsg = "Lo siento, estoy teniendo problemas para acceder a la información de horarios en este momento (código C01). Por favor, intenta más tarde.";
        if (typeof logRigbotMessage === "function") { try { await logRigbotMessage({ role: "assistant", content: errorMsg, sessionId: currentSessionId, ip: ipAddress, clientId: requestClientId }); } catch (e) { console.error("Log Error:", e) } }
        return res.status(503).json({ response: errorMsg });
      }
      // ----- FIN LÓGICA DE SELECCIÓN DE CALENDARIO -----
      
      // ----- INICIO DE LÓGICA DE CALENDARIO DEL "PROTOTIPO ANTIGUO" ADAPTADA -----
      // (Basada en el chat.js que me pasaste en la respuesta #79)
      const serverNowUtc = new Date();
      let targetDateForDisplay = null; 
      let targetDateIdentifierForSlotFilter = null;
      let targetHourChile = null;
      let targetMinuteChile = 0;
      let timeOfDay = null;
      let isGenericNextWeekSearch = false;

      // Calculamos el inicio del día de HOY en Chile, en UTC.
      const nowInChileLocaleString = serverNowUtc.toLocaleString("en-US", { timeZone: "America/Santiago" });
      const nowInChileDateObject = new Date(nowInChileLocaleString);
      const refDateForTargetCalc = new Date(Date.UTC(nowInChileDateObject.getFullYear(), nowInChileDateObject.getMonth(), nowInChileDateObject.getDate(), 0 - CHILE_UTC_OFFSET_HOURS, 0, 0, 0));
      const actualCurrentDayOfWeekInChile = new Date(refDateForTargetCalc.toLocaleString("en-US", {timeZone: "America/Santiago"})).getDay();
      
      console.log(`DEBUG CAL: ---- Inicio de Parseo de Fechas para "${message}" ----`);
      console.log(`DEBUG CAL: serverNowUtc: ${serverNowUtc.toISOString()}`);
      console.log(`DEBUG CAL: refDateForTargetCalc (Hoy 00:00 Chile, en UTC): ${refDateForTargetCalc.toISOString()}`);

      // (Tu lógica de parseo de 'lowerMessage' para determinar targetDateForDisplay, targetHourChile, etc. del Prototipo Antiguo)
      const isProximoWordQuery = calendarKeywords.some(k => k.startsWith("proximo") && lowerMessage.includes(k));
      const isAnyNextWeekIndicator = calendarKeywords.some(k => k.includes("semana") && lowerMessage.includes(k));
      let specificDayKeywordIndex = -1;
      const dayKeywordsList = [ /* ... (tu lista) ... */ ];
      for (const dayInfo of dayKeywordsList) { if (lowerMessage.includes(dayInfo.keyword)) { specificDayKeywordIndex = dayInfo.index; break; } }
      
      if (lowerMessage.includes('hoy')) {
        targetDateForDisplay = new Date(refDateForTargetCalc.getTime());
      } else if (lowerMessage.includes('mañana') && !lowerMessage.includes('pasado mañana')) {
        targetDateForDisplay = new Date(refDateForTargetCalc.getTime());
        targetDateForDisplay.setUTCDate(refDateForTargetCalc.getUTCDate() + 1);
      } else if (specificDayKeywordIndex !== -1) {
          targetDateForDisplay = new Date(refDateForTargetCalc.getTime());
          let daysToAdd = specificDayKeywordIndex - actualCurrentDayOfWeekInChile;
          if (daysToAdd < 0 || (daysToAdd === 0 && isProximoWordQuery && specificDayKeywordIndex === actualCurrentDayOfWeekInChile)) { 
             daysToAdd += 7; 
          } else if (daysToAdd === 0 && !isProximoWordQuery) {
            const serverNowChileHour = nowInChileDateObject.getHours();
            if (serverNowChileHour >= 19) { daysToAdd += 7; }
          }
          targetDateForDisplay.setUTCDate(refDateForTargetCalc.getUTCDate() + daysToAdd);
      } else if (isAnyNextWeekIndicator) { 
          targetDateForDisplay = new Date(refDateForTargetCalc.getTime());
          let daysUntilNextMonday = (1 - actualCurrentDayOfWeekInChile + 7) % 7;
          if (daysUntilNextMonday === 0 && actualCurrentDayOfWeekInChile === 1) daysUntilNextMonday = 7; // Si hoy es Lunes y pide "próxima semana"
          targetDateForDisplay.setUTCDate(refDateForTargetCalc.getUTCDate() + daysUntilNextMonday);
          isGenericNextWeekSearch = true;
      }
      // Fin de tu lógica de parseo de fechas

      if (targetDateForDisplay) {
        console.log(`DEBUG CAL: 🎯 Fecha Objetivo (Display): ${new Intl.DateTimeFormat('es-CL', { dateStyle: 'full', timeZone: 'America/Santiago' }).format(targetDateForDisplay)} (UTC: ${targetDateForDisplay.toISOString()})`);
        // ... (tu lógica de validación de MAX_DAYS_FOR_USER_REQUEST)
      } else {
        console.log(`DEBUG CAL: 🎯 Búsqueda genérica, targetDateForDisplay no establecido explícitamente.`);
      }
            
      targetDateIdentifierForSlotFilter = (targetDateForDisplay && !isGenericNextWeekSearch) ? getDayIdentifier(targetDateForDisplay, 'America/Santiago') : null;
      console.log(`DEBUG CAL: targetDateIdentifierForSlotFilter (YYYY-MM-DD Chile): ${targetDateIdentifierForSlotFilter}`);
            
      // (Tu lógica de parseo de hora y timeOfDay del Prototipo Antiguo)
      const timeMatch = lowerMessage.match(/(\d{1,2})\s*(:(00|30|15|45))?\s*(pm|am|h|hr|hrs)?/i);
      if (timeMatch) { /* ... */ }
      if (!targetHourChile) { /* ... */ }
      if(timeOfDay) console.log(`DEBUG CAL: timeOfDay (franja horaria solicitada): ${timeOfDay}`);
      const WORKING_HOURS_CHILE_NUMERIC = [10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5, 14, 14.5, 15, 15.5, 16, 16.5, 17, 17.5, 18, 18.5, 19, 19.5];
      if (targetHourChile !== null) { /* ... (tu validación de hora fuera de horario) ... */ }
      
      // ----- CÁLCULO DE RANGO DE CONSULTA A GOOGLE CALENDAR -----
      let timeMinForQuery;
      const nowUtcWithBuffer = new Date(serverNowUtc.getTime() + 1 * 60 * 1000); 

      if (targetDateForDisplay) {
        timeMinForQuery = new Date(targetDateForDisplay.getTime()); 
        if (getDayIdentifier(targetDateForDisplay, 'America/Santiago') === getDayIdentifier(nowInChileDateObject, 'America/Santiago')) {
            if (timeMinForQuery < nowUtcWithBuffer) { timeMinForQuery = nowUtcWithBuffer; }
        }
      } else {
        timeMinForQuery = nowUtcWithBuffer;
      }

      const timeMaxForQuery = new Date(timeMinForQuery.getTime());
      let daysForGoogleQuery = effectiveConfig.calendarQueryDays; // Días a consultar en Google
      if (targetDateIdentifierForSlotFilter && !isGenericNextWeekSearch) { // Si es un día específico
          // Queremos el final de ESE día en Chile para timeMax
          const endOfDayTargetInChile = new Date(targetDateForDisplay.toLocaleString("en-US", {timeZone: "America/Santiago"}));
          endOfDayTargetInChile.setHours(23, 59, 59, 999);
          timeMaxForQuery.setTime(Date.UTC(
              endOfDayTargetInChile.getFullYear(), 
              endOfDayTargetInChile.getMonth(), 
              endOfDayTargetInChile.getDate(), 
              endOfDayTargetInChile.getHours() - CHILE_UTC_OFFSET_HOURS, 
              endOfDayTargetInChile.getMinutes(), 
              endOfDayTargetInChile.getSeconds(), 
              endOfDayTargetInChile.getMilliseconds()
          ));
          daysForGoogleQuery = 1; // Iteraremos solo 1 día para los slots
          console.log(`DEBUG CAL: Búsqueda para día específico. Google Query Days = 1.`);
      } else {
          timeMaxForQuery.setUTCDate(timeMinForQuery.getUTCDate() + effectiveConfig.calendarQueryDays);
          console.log(`DEBUG CAL: Búsqueda genérica. Google Query Days = ${effectiveConfig.calendarQueryDays}`);
      }
      console.log(`🗓️ Google Calendar Query para ${requestClientId} ... De ${timeMinForQuery.toISOString()} a ${timeMaxForQuery.toISOString()}`);
      // ----- FIN CÁLCULO DE RANGO -----
      
      let googleResponse;
      try {
        googleResponse = await calendar.events.list({
            calendarId: 'primary', timeMin: timeMinForQuery.toISOString(), timeMax: timeMaxForQuery.toISOString(),
            singleEvents: true, orderBy: 'startTime', maxResults: 250 
        });
      } catch (googleError) { /* ... (tu manejo de error de API de Google) ... */ }
            
      const eventsFromGoogle = googleResponse?.data?.items || [];
      console.log(`INFO CAL: Se obtuvieron ${eventsFromGoogle.length} eventos del calendario para ${requestClientId}.`);
      if (eventsFromGoogle.length > 0) { console.log("DEBUG CAL: Eventos de Google (resumen):", JSON.stringify(eventsFromGoogle.map(e => ({summary: e.summary, start: e.start?.dateTime || e.start?.date, end: e.end?.dateTime || e.end?.date, status: e.status})), null, 2)); }
      
      const busySlots = eventsFromGoogle.filter(e => e.status !== 'cancelled').map(e => { /* ... (tu lógica de busySlots del prototipo) ... */ }).filter(Boolean);
      if (busySlots.length > 0) { console.log("DEBUG CAL: Busy Slots calculados (timestamps UTC):", JSON.stringify(busySlots)); }

      const WORKING_HOURS_CHILE_STR = ['10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30', '14:00', '14:30', '15:00', '15:30', '16:00', '16:30', '17:00', '17:30', '18:00', '18:30', '19:00', '19:30'];
      const availableSlotsOutput = [];
      const processedDaysForGenericQuery = new Set();
      
      // Base para el bucle de días: el inicio del primer día que queremos mostrar slots.
      // Si se pidió un día específico, es ese día. Si no, es "hoy".
      let dayLoopStartBaseChile = targetDateForDisplay ? new Date(targetDateForDisplay.getTime()) : new Date(refDateForTargetCalc.getTime());
      // Este dayLoopStartBaseChile ya representa 00:00 Chile en UTC.

      console.log(`DEBUG CAL: Iniciando bucle de slots. DayLoopStartBaseChile (UTC): ${dayLoopStartBaseChile.toISOString()}. Iterando ${daysForGoogleQuery} días (o hasta ${effectiveConfig.calendarQueryDays} para genérico).`);
      
      // El bucle debe iterar sobre los días para los que tenemos eventos o queremos generar slots.
      // Si es un día específico, daysForGoogleQuery es 1. Si es genérico, es effectiveConfig.calendarQueryDays.
      for (let i = 0; i < (targetDateIdentifierForSlotFilter && !isGenericNextWeekSearch ? 1 : effectiveConfig.calendarQueryDays) ; i++) {
        const currentProcessingDayUTC = new Date(dayLoopStartBaseChile.getTime());
        currentProcessingDayUTC.setUTCDate(dayLoopStartBaseChile.getUTCDate() + i);
        
        const currentDayIdentifierInChile = getDayIdentifier(currentProcessingDayUTC, 'America/Santiago');
        console.log(`DEBUG CAL: Procesando día ${i + 1}: ${currentDayIdentifierInChile} (UTC del inicio del día Chile: ${currentProcessingDayUTC.toISOString()})`);

        // Si se busca un día específico y este no es el día actual del bucle, saltar.
        if (targetDateIdentifierForSlotFilter && currentDayIdentifierInChile !== targetDateIdentifierForSlotFilter) {
            console.log(`DEBUG CAL: Día del bucle ${currentDayIdentifierInChile} no es el día objetivo ${targetDateIdentifierForSlotFilter}. Saltando.`);
            continue; 
        }

        for (const timeChileStr of WORKING_HOURS_CHILE_STR) {
            const [hChile, mChile] = timeChileStr.split(':').map(Number);
            // ... (Tus filtros de hora específica y franja horaria (timeOfDay) del prototipo) ...
            
            const slotStartUtc = convertChileTimeToUtc(currentProcessingDayUTC, hChile, mChile);
            if (isNaN(slotStartUtc.getTime())) { continue; }
            
            // No mostrar slots pasados (solo si estamos procesando HOY)
            if (getDayIdentifier(currentProcessingDayUTC, 'America/Santiago') === getDayIdentifier(nowInChileDateObject, 'America/Santiago') && slotStartUtc < nowUtcWithBuffer) {
              continue; 
            }
            
            const slotEndUtc = new Date(slotStartUtc.getTime() + 30 * 60 * 1000);
            const isBusy = busySlots.some(busy => slotStartUtc.getTime() < busy.end && slotEndUtc.getTime() > busy.start);
            
            console.log(`DEBUG CAL: Evaluando Slot: ${currentDayIdentifierInChile} ${timeChileStr} (UTC: ${slotStartUtc.toISOString()}), Ocupado: ${isBusy}`);

            if (!isBusy) {
              console.log(`DEBUG CAL: Slot ${timeChileStr} (${currentDayIdentifierInChile}) está LIBRE. Añadiendo.`);
              const formattedSlot = new Intl.DateTimeFormat('es-CL', {weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'America/Santiago'}).format(slotStartUtc);
              // ... (Lógica del prototipo para añadir a availableSlotsOutput y processedDaysForGenericQuery) ...
            }
        } 
        
        if (targetDateIdentifierForSlotFilter && currentDayIdentifierInChile === targetDateIdentifierForSlotFilter) {
            if (targetHourChile !== null || availableSlotsOutput.length >= effectiveConfig.maxSuggestions ) break; 
        }
        if (availableSlotsOutput.length >= effectiveConfig.maxSuggestions && !targetDateIdentifierForSlotFilter && !targetHourChile && processedDaysForGenericQuery.size >=2) break; 
      } 
      console.log("DEBUG CAL: availableSlotsOutput final:", JSON.stringify(availableSlotsOutput));
      
      // ----- TU LÓGICA ORIGINAL PARA FORMATEAR replyCalendar (del Prototipo Antiguo) -----
      // (Esta es la parte que crea el mensaje final para el usuario)
      let replyCalendar = '';
      // ... (Pega aquí TU lógica original completa del prototipo para construir replyCalendar 
      //      basada en availableSlotsOutput, targetHourChile, targetDateForDisplay, etc.
      //      y usando getWhatsappContactMessage y getWhatsappDerivationSuffix) ...
      // Ejemplo de cómo podría empezar (debes usar tu lógica probada):
      if (targetHourChile !== null) { 
        if (availableSlotsOutput.length > 0) {
          replyCalendar = `¡Excelente! 🎉 Justo el ${availableSlotsOutput[0]} está libre para ti. ¡Qué buena suerte! Para asegurar tu cita,${getWhatsappDerivationSuffix(effectiveConfig.whatsappNumber)} 😉`;
        } else { /* ... tu mensaje de hora no disponible ... */ }
      } else if (availableSlotsOutput.length > 0) {
        let finalSuggestions = availableSlotsOutput.slice(0, effectiveConfig.maxSuggestions);
        replyCalendar = `¡Buenas noticias! 🎉 Encontré estas horitas disponibles:\n- ${finalSuggestions.join('\n- ')}`;
        if (availableSlotsOutput.length > finalSuggestions.length) { replyCalendar += `\n\n(Y ${availableSlotsOutput.length - finalSuggestions.length} más! 😉)`;}
        replyCalendar += `\n\nPara reservar alguna o si buscas otra opción,${getWhatsappDerivationSuffix(effectiveConfig.whatsappNumber)}`;
      } else { 
        replyCalendar = '¡Pucha! 😔 Parece que no tengo horas libres';
        if (targetDateForDisplay) { replyCalendar += ` para el ${new Intl.DateTimeFormat('es-CL', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Santiago' }).format(targetDateForDisplay)}`;}
        replyCalendar += `.${getWhatsappContactMessage(effectiveConfig.whatsappNumber)}`;
      }
      // ----- FIN LÓGICA DE replyCalendar -----

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

    const chatResponse = await openai.chat.completions.create({
      model: MODEL_FALLBACK,
      messages: [ { role: 'system', content: finalSystemPrompt }, { role: 'user', content: message } ]
    });
    let gptReply = chatResponse.choices[0].message.content.trim();
    if (typeof logRigbotMessage === "function") { /* ... */ }
    return res.status(200).json({ response: gptReply });

  } catch (error) {
    console.error(`❌ Error en Rigbot para clientId ${requestClientId}:`, error.message, error.stack);
    const errorForUser = 'Ocurrió un error inesperado en Rigbot. Por favor, intenta más tarde.';
    if (typeof logRigbotMessage === "function") { /* ... */ }
    return res.status(500).json({ error: errorForUser, details: /* ... */ });
  }
}