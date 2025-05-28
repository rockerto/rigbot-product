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

const defaultConfig = { /* ... (tu defaultConfig se mantiene igual) ... */ 
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
  const newUtcDate = new Date(baseDateUtcDay.getTime()); // Clonar para no modificar el original
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
  // --- Lógica de CORS y validación de método POST (sin cambios) ---
  // ... (tu lógica de CORS aquí) ...
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

  if (!db) { /* ... (manejo de error de db) ... */ }

  // --- VALIDACIÓN DE CLIENTID Y CLAVE (sin cambios) ---
  if (!requestClientId || typeof requestClientId !== 'string') { /* ... */ }
  let clientDocSnap;
  let clientConfigData;
  try {
    const clientDocRef = db.collection('clients').doc(requestClientId);
    clientDocSnap = await clientDocRef.get();
    if (!clientDocSnap.exists) { /* ... */ }
    clientConfigData = clientDocSnap.data();
    console.log(`API Chat: Configuración del cliente ${requestClientId} obtenida de Firestore.`);
  } catch (error) { /* ... */ }
  const expectedClave = clientConfigData?.clave;
  if (expectedClave && typeof expectedClave === 'string' && expectedClave.trim() !== "") {
    if (expectedClave !== incomingClave) { /* ... */ }
  }
  // --- FIN VALIDACIÓN ---

  if (!message) { /* ... (manejo de error de mensaje faltante) ... */ }
  if (typeof logRigbotMessage === "function") { /* ... (tu logueo de mensaje de usuario) ... */ }

  let effectiveConfig = { ...defaultConfig };
  if (clientConfigData) { /* ... (tu lógica para poblar effectiveConfig) ... */ }
  console.log("🧠 Configuración efectiva usada para clientId", requestClientId, ":", JSON.stringify(effectiveConfig, null, 2));
  
  const getWhatsappContactMessage = (contactNumber) => { /* ... (sin cambios) ... */ };
  const getWhatsappDerivationSuffix = (contactNumber) => { /* ... (sin cambios) ... */ };

  try {
    console.log(`📨 Mensaje ("${message}") recibido para ${requestClientId}`);
    const lowerMessage = message.toLowerCase();
    const calendarKeywords = [ /* ... tus keywords ... */ ];
    const isCalendarQuery = calendarKeywords.some(keyword => lowerMessage.includes(keyword));

    if (isCalendarQuery) {
      console.log(`⏳ Detectada consulta de calendario para ${requestClientId}`);
      let calendar;

      // ----- LÓGICA PARA USAR CALENDARIO DEL CLIENTE O DEFAULT (sin cambios significativos, solo logs) -----
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
                clientConfigData.googleCalendarTokens = credentials; // Actualiza la copia local
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
        console.log(`INFO: Cliente ${requestClientId} no tiene Google Calendar conectado o faltan tokens. Usando calendario por defecto.`);
        calendar = await getDefaultCalendarClient();
      }
      if (!calendar || typeof calendar.events?.list !== 'function') { /* ... (manejo de error de calendario no disponible) ... */ }
      // ----- FIN LÓGICA DE SELECCIÓN DE CALENDARIO -----
      
      const serverNowUtc = new Date(); 
      let targetDateForDisplay = null; // Fecha específica que el usuario podría haber mencionado (en UTC, inicio del día Chile)
      let targetDateIdentifierForSlotFilter = null; // YYYY-MM-DD en Chile para filtrar slots
      let targetHourChile = null;
      let targetMinuteChile = 0;
      let timeOfDay = null; 
      let isGenericNextWeekSearch = false;

      // --- LÓGICA DE PARSEO DE FECHAS DEL USUARIO (REVISADA Y CON MÁS LOGS) ---
      const nowInChileLocaleString = serverNowUtc.toLocaleString("en-US", { timeZone: "America/Santiago" });
      const nowInChileDateObject = new Date(nowInChileLocaleString); // Fecha y hora actual en Chile
      
      // refDateForTargetCalc: Representa el inicio del día de HOY en Chile (00:00 Chile), expresado como un objeto Date en UTC.
      const refDateForTargetCalc = new Date(Date.UTC(nowInChileDateObject.getFullYear(), nowInChileDateObject.getMonth(), nowInChileDateObject.getDate(), 0 - CHILE_UTC_OFFSET_HOURS, 0, 0, 0));
      const actualCurrentDayOfWeekInChile = new Date(refDateForTargetCalc.toLocaleString("en-US", {timeZone: "America/Santiago"})).getDay(); // 0 (Dom) - 6 (Sab)
      
      console.log(`DEBUG CAL: serverNowUtc: ${serverNowUtc.toISOString()}`);
      console.log(`DEBUG CAL: nowInChileLocaleString: ${nowInChileLocaleString}`);
      console.log(`DEBUG CAL: nowInChileDateObject (interpretada localmente): ${nowInChileDateObject.toString()}`);
      console.log(`DEBUG CAL: refDateForTargetCalc (Hoy 00:00 Chile, en UTC): ${refDateForTargetCalc.toISOString()}`);
      console.log(`DEBUG CAL: actualCurrentDayOfWeekInChile (0=Dom, 1=Lun): ${actualCurrentDayOfWeekInChile}`);

      const isProximoWordQuery = calendarKeywords.some(k => k.startsWith("proximo") && lowerMessage.includes(k));
      const isAnyNextWeekIndicator = calendarKeywords.some(k => k.includes("semana") && lowerMessage.includes(k));
      let specificDayKeywordIndex = -1;
      const dayKeywordsList = [ /* ... (sin cambios) ... */ ];
      for (const dayInfo of dayKeywordsList) { if (lowerMessage.includes(dayInfo.keyword)) { specificDayKeywordIndex = dayInfo.index; break; } }
      
      if (lowerMessage.includes('hoy')) {
        targetDateForDisplay = new Date(refDateForTargetCalc.getTime());
      } else if (lowerMessage.includes('mañana') && !lowerMessage.includes('pasado mañana')) {
        targetDateForDisplay = new Date(refDateForTargetCalc.getTime());
        targetDateForDisplay.setUTCDate(targetDateForDisplay.getUTCDate() + 1);
      } else if (specificDayKeywordIndex !== -1) {
          targetDateForDisplay = new Date(refDateForTargetCalc.getTime());
          let daysToAdd = specificDayKeywordIndex - actualCurrentDayOfWeekInChile;
          if (daysToAdd < 0 || (daysToAdd === 0 && isProximoWordQuery)) { 
            daysToAdd += 7; 
          } else if (daysToAdd === 0 && !isProximoWordQuery) { // "Lunes" y hoy es Lunes
            const serverNowChileHour = nowInChileDateObject.getHours();
            if (serverNowChileHour >= 19) { // Si es tarde, buscar para la próxima semana
                daysToAdd += 7;
            }
          }
          targetDateForDisplay.setUTCDate(targetDateForTargetCalc.getUTCDate() + daysToAdd);
      } else if (isAnyNextWeekIndicator) { 
          targetDateForDisplay = new Date(refDateForTargetCalc.getTime());
          let daysUntilNextMonday = (1 - actualCurrentDayOfWeekInChile + 7) % 7;
          if (daysUntilNextMonday === 0 && actualCurrentDayOfWeekInChile === 1) daysUntilNextMonday = 7;
          targetDateForDisplay.setUTCDate(targetDateForTargetCalc.getUTCDate() + daysUntilNextMonday);
          isGenericNextWeekSearch = true;
      }
      // Si targetDateForDisplay sigue siendo null, la búsqueda es genérica desde hoy.

      if (targetDateForDisplay) { /* ... (tu validación de fecha muy lejana, sin cambios) ... */ }
            
      targetDateIdentifierForSlotFilter = (targetDateForDisplay && !isGenericNextWeekSearch) ? getDayIdentifier(targetDateForDisplay, 'America/Santiago') : null;
      console.log(`DEBUG CAL: targetDateForDisplay (para query, UTC): ${targetDateForDisplay ? targetDateForDisplay.toISOString() : 'Desde hoy'}`);
      console.log(`DEBUG CAL: targetDateIdentifierForSlotFilter (YYYY-MM-DD Chile): ${targetDateIdentifierForSlotFilter}`);
            
      const timeMatch = lowerMessage.match(/(\d{1,2})\s*(:(00|30|15|45))?\s*(pm|am|h|hr|hrs)?/i);
      if (timeMatch) { /* ... (tu lógica de parseo de hora, sin cambios sustanciales) ... */ }

      // Lógica para timeOfDay (mañana/tarde)
      if (!targetHourChile) { // Solo si no se especificó una hora exacta
        if (targetDateIdentifierForSlotFilter) { // Si se especificó un día
            if (lowerMessage.includes('tarde')) timeOfDay = 'afternoon';
            else if (lowerMessage.includes('mañana') && (lowerMessage.includes(dayKeywordsList.find(d=>d.index === new Date(targetDateForDisplay.toLocaleString("en-US", {timeZone: "America/Santiago"})).getDay())?.keyword || 'impossible_match') || targetDateForDisplay > refDateForTargetCalc)) {
                // "Mañana por la mañana" o "[Día específico] por la mañana"
                timeOfDay = 'morning';
            }
        } else if (!isGenericNextWeekSearch) { // Búsqueda genérica desde hoy
            if (lowerMessage.includes('tarde')) timeOfDay = 'afternoon';
            else if (lowerMessage.includes('mañana')) timeOfDay = 'morning';
        }
      }
      if(timeOfDay) console.log(`DEBUG CAL: timeOfDay (franja horaria solicitada): ${timeOfDay}`);
      
      const WORKING_HOURS_CHILE_NUMERIC = [10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5, 14, 14.5, 15, 15.5, 16, 16.5, 17, 17.5, 18, 18.5, 19, 19.5];
      if (targetHourChile !== null) { /* ... (tu validación de hora dentro de horario de atención) ... */ }
      // --- FIN LÓGICA DE PARSEO ---

      // --- CÁLCULO DE RANGO DE CONSULTA A GOOGLE CALENDAR (REVISADO) ---
      let timeMinForQuery;
      const nowUtcWithBuffer = new Date(serverNowUtc.getTime() + 1 * 60 * 1000); // Ahora + 1 minuto

      if (targetDateForDisplay) {
        timeMinForQuery = new Date(targetDateForDisplay.getTime()); // Comienza desde el inicio del día objetivo (ya en UTC)
        // Si el día objetivo es HOY, pero la hora actual ya pasó algunas horas de trabajo, ajustar timeMin
        if (getDayIdentifier(targetDateForDisplay, 'UTC') === getDayIdentifier(serverNowUtc, 'UTC') && timeMinForQuery < nowUtcWithBuffer) {
            timeMinForQuery = nowUtcWithBuffer;
        }
      } else {
        timeMinForQuery = nowUtcWithBuffer; // Búsqueda genérica, empezar desde ahora + buffer
      }

      const timeMaxForQuery = new Date(timeMinForQuery.getTime());
      // Si se busca un día específico, el timeMax debería ser el final de ESE día.
      // Si es una búsqueda genérica, se usa effectiveConfig.calendarQueryDays.
      let actualQueryDays = effectiveConfig.calendarQueryDays;
      if (targetDateIdentifierForSlotFilter && !isGenericNextWeekSearch) {
          actualQueryDays = 1; 
          timeMaxForQuery.setUTCDate(timeMinForQuery.getUTCDate() + 1); // Hasta el inicio del día siguiente (exclusivo para el día actual)
          timeMaxForQuery.setUTCHours(0 - CHILE_UTC_OFFSET_HOURS, 0, 0, 0); // Asegurar que sea 00:00 Chile del día siguiente
      } else {
          timeMaxForQuery.setUTCDate(timeMinForQuery.getUTCDate() + effectiveConfig.calendarQueryDays);
      }
      console.log(`🗓️ Google Calendar Query para ${requestClientId} (Calendario: ${clientConfigData?.googleCalendarConnected && clientConfigData.googleCalendarEmail ? clientConfigData.googleCalendarEmail : (clientConfigData?.googleCalendarConnected ? 'Cliente (email no obtenido)' : 'Default')}): De ${timeMinForQuery.toISOString()} a ${timeMaxForQuery.toISOString()}`);
      // --- FIN CÁLCULO DE RANGO ---
      
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
      // (Opcional) Loguear los eventos obtenidos para depuración:
      // if (eventsFromGoogle.length > 0) { console.log("DEBUG CAL: Eventos de Google:", JSON.stringify(eventsFromGoogle.map(e => ({summary: e.summary, start: e.start, end: e.end})), null, 2)); }
      
      const busySlots = eventsFromGoogle.filter(e => e.status !== 'cancelled')
        .map(e => { /* ... (tu lógica de busySlots, sin cambios) ... */ }).filter(Boolean);
      // (Opcional) Loguear busySlots
      // if (busySlots.length > 0) { console.log("DEBUG CAL: Busy Slots calculados (UTC times):", JSON.stringify(busySlots)); }


      const WORKING_HOURS_CHILE_STR = ['10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30', '14:00', '14:30', '15:00', '15:30', '16:00', '16:30', '17:00', '17:30', '18:00', '18:30', '19:00', '19:30'];
      const availableSlotsOutput = [];
      const processedDaysForGenericQuery = new Set();
      
      let iterationBaseDateUTC = targetDateForDisplay ? new Date(targetDateForDisplay.getTime()) : new Date(refDateForTargetCalc.getTime());
      // Para el bucle, siempre empezamos desde el inicio del día (en UTC) de la primera fecha que nos interesa.
      iterationBaseDateUTC.setUTCHours(0,0,0,0); 

      console.log(`DEBUG CAL: Iniciando bucle de slots. IterationBaseDateUTC (inicio del día en UTC): ${iterationBaseDateUTC.toISOString()}. Querying ${actualQueryDays} dias.`);

      for (let i = 0; i < actualQueryDays; i++) {
        const currentDayBeingProcessedUTC = new Date(iterationBaseDateUTC.getTime());
        currentDayBeingProcessedUTC.setUTCDate(iterationBaseDateUTC.getUTCDate() + i);
        const currentDayIdentifierChile = getDayIdentifier(currentDayBeingProcessedUTC, 'America/Santiago');
        
        console.log(`DEBUG CAL: Procesando día ${i + 1}/${actualQueryDays}: ${currentDayIdentifierChile} (UTC: ${currentDayBeingProcessedUTC.toISOString()})`);

        // Si se busca un día específico (targetDateIdentifierForSlotFilter NO es null), 
        // y el día actual del bucle no es ese día, no procesamos sus horas.
        if (targetDateIdentifierForSlotFilter && currentDayIdentifierChile !== targetDateIdentifierForSlotFilter) {
            console.log(`DEBUG CAL: Día ${currentDayIdentifierChile} no es el día objetivo ${targetDateIdentifierForSlotFilter}. Saltando al siguiente día del bucle.`);
            continue; 
        }

        for (const timeChileStr of WORKING_HOURS_CHILE_STR) {
            const [hChile, mChile] = timeChileStr.split(':').map(Number);
            
            // Filtro por hora específica solicitada
            if (targetHourChile !== null) {
              if (hChile !== targetHourChile || mChile !== targetMinuteChile) { continue; }
            } 
            // Filtro por franja horaria (mañana/tarde) SOLO si se especificó un día o es una búsqueda genérica sin día
            else if (timeOfDay) {
                if (targetDateIdentifierForSlotFilter === currentDayIdentifierChile || !targetDateIdentifierForSlotFilter) { // Aplicar franja si es el día buscado o búsqueda genérica
                    if (timeOfDay === 'morning' && (hChile < 10 || hChile >= 14)) continue;
                    if (timeOfDay === 'afternoon' && (hChile < 14 || hChile > 19 || (hChile === 19 && mChile > 30))) continue;
                }
            }

            // currentDayBeingProcessedUTC ya representa el inicio del día en UTC (ej. 2025-05-29T00:00:00.000Z)
            // convertChileTimeToUtc necesita el inicio del día en Chile, pero como objeto Date UTC.
            // refDateForTargetCalc (hoy 00:00 Chile UTC) o targetDateForDisplay (ej. mañana 00:00 Chile UTC)
            // currentDayBeingProcessedUTC es el día correcto para pasarlo a convertChileTimeToUtc
            const slotStartUtc = convertChileTimeToUtc(currentDayBeingProcessedUTC, hChile, mChile);
            if (isNaN(slotStartUtc.getTime())) { /* ... */ continue; }
            
            // No mostrar slots pasados (comparando con AHORA + buffer)
            if (slotStartUtc < nowUtcWithBuffer) {
              // console.log(`DEBUG CAL: Slot ${timeChileStr} en ${currentDayIdentifierChile} es pasado (${slotStartUtc.toISOString()} vs ${nowUtcWithBuffer.toISOString()}). Saltando.`);
              continue; 
            }
            
            const slotEndUtc = new Date(slotStartUtc.getTime() + 30 * 60 * 1000);
            const isBusy = busySlots.some(busy => slotStartUtc.getTime() < busy.end && slotEndUtc.getTime() > busy.start);
            
            // console.log(`DEBUG CAL: Slot ${timeChileStr} (${currentDayIdentifierChile}), UTC: ${slotStartUtc.toISOString()}, Chile: ${new Intl.DateTimeFormat('es-CL', {timeStyle:'short', timeZone:'America/Santiago'}).format(slotStartUtc)}, Ocupado: ${isBusy}`);

            if (!isBusy) {
              // ... (tu lógica para añadir a availableSlotsOutput y processedDaysForGenericQuery) ...
            }
        } // Fin bucle timeChileStr
        
        if (targetDateIdentifierForSlotFilter && currentDayIdentifierChile === targetDateIdentifierForSlotFilter) {
            // Si ya procesamos el día específico que se buscaba, no necesitamos seguir con más días.
            console.log(`DEBUG CAL: Se procesó el día específico ${targetDateIdentifierForSlotFilter}. Terminando bucle de días.`);
            break; 
        }
        // Lógica de corte de bucle para búsqueda general
        if (availableSlotsOutput.length >= effectiveConfig.maxSuggestions && !targetDateIdentifierForSlotFilter && !targetHourChile && processedDaysForGenericQuery.size >=2) {
            break;
        }
      } 
      console.log("DEBUG CAL: availableSlotsOutput final:", JSON.stringify(availableSlotsOutput));
      // ----- FIN TU LÓGICA ORIGINAL DE PROCESAMIENTO DE CALENDARIO -----


      // ----- INICIO DE TU LÓGICA ORIGINAL PARA FORMATEAR LA RESPUESTA DE CALENDARIO (sin cambios) -----
      let replyCalendar = '';
      // ... (toda tu lógica para construir replyCalendar basada en availableSlotsOutput se mantiene) ...
      // ----- FIN TU LÓGICA ORIGINAL PARA FORMATEAR LA RESPUESTA DE CALENDARIO -----

      console.log('✅ Respuesta generada (Calendario REAL):', replyCalendar);
      if (typeof logRigbotMessage === "function") { try { await logRigbotMessage({ role: "assistant", content: replyCalendar, sessionId: currentSessionId, ip: ipAddress, clientId: requestClientId }); } catch(e){console.error("Log Error:",e)} }
      return res.status(200).json({ response: replyCalendar });
    } // Fin de if (isCalendarQuery)

    // --- Rama de OpenAI (sin cambios) ---
    // ... (tu lógica de OpenAI) ...

  } catch (error) {
    // ... (tu manejo de error global) ...
  }
}