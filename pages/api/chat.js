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
  const newUtcDate = new Date(baseDateUtcDay);
  newUtcDate.setUTCHours(utcHour, chileMinute, 0, 0);
  return newUtcDate;
}

function getDayIdentifier(dateObj, timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    timeZone: timeZone
  }).format(dateObj);
}

function getWhatsappContactMessage(contactNumber) {
    const wsp = String(contactNumber || '').trim();
   if (wsp && wsp !== WHATSAPP_FALLBACK_PLACEHOLDER && wsp !== "") {
     return ` Para más detalles o para agendar, conversemos por WhatsApp 👉 ${wsp}`;
   }
   return " Para más detalles o para agendar, por favor contáctanos a través de nuestros canales principales.";
}

function getWhatsappDerivationSuffix(contactNumber) {
    const wsp = String(contactNumber || '').trim();
   if (wsp && wsp !== WHATSAPP_FALLBACK_PLACEHOLDER && wsp !== "") {
     return ` ¡Escríbenos por WhatsApp al 👉 ${wsp}!`;
   }
   return " ¡Contáctanos para coordinar!";
}

const monthMap = {
    'ene': 0, 'enero': 0, 'feb': 1, 'febrero': 1, 'mar': 2, 'marzo': 2,
    'abr': 3, 'abril': 3, 'may': 4, 'mayo': 4, 'jun': 5, 'junio': 5,
    'jul': 6, 'julio': 6, 'ago': 7, 'agosto': 7, 'sep': 8, 'septiembre': 8, 'set': 8,
    'oct': 9, 'octubre': 9, 'nov': 10, 'noviembre': 10, 'dic': 11, 'diciembre': 11
};

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

  if (!requestClientId || typeof requestClientId !== 'string') {
    return res.status(400).json({ error: "Client ID no válido o no proporcionado." });
  }
  let clientDocSnap;
  let clientConfigData;
  try {
    const clientDocRef = db.collection('clients').doc(requestClientId);
    clientDocSnap = await clientDocRef.get();
    if (!clientDocSnap.exists) {
      console.warn(`API Chat: ClientId '${requestClientId}' no registrado en Firestore. Acceso denegado.`);
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
    effectiveConfig = { ...defaultConfig, ...clientConfigData }; 
    effectiveConfig.calendarQueryDays = Number(clientConfigData.calendarQueryDays) || defaultConfig.calendarQueryDays;
    effectiveConfig.calendarMaxUserRequestDays = Number(clientConfigData.calendarMaxUserRequestDays) || defaultConfig.calendarMaxUserRequestDays;
    effectiveConfig.maxSuggestions = clientConfigData.maxSuggestions !== undefined ? Number(clientConfigData.maxSuggestions) : defaultConfig.maxSuggestions;
    effectiveConfig.whatsappNumber = String(clientConfigData.whatsappNumber || defaultConfig.whatsappNumber).trim();
    effectiveConfig.pricingInfo = String(clientConfigData.pricingInfo || defaultConfig.pricingInfo);
    effectiveConfig.direccion = String(clientConfigData.direccion || defaultConfig.direccion);
    effectiveConfig.horario = String(clientConfigData.horario || defaultConfig.horario);
    effectiveConfig.chiropracticVideoUrl = String(clientConfigData.chiropracticVideoUrl || defaultConfig.chiropracticVideoUrl);
    effectiveConfig.telefono = String(clientConfigData.telefono || defaultConfig.telefono);
  }
  console.log("🧠 Configuración efectiva usada para clientId", requestClientId, ":", JSON.stringify(effectiveConfig, null, 2));

  try {
    console.log(`📨 Mensaje ("${message}") recibido para ${requestClientId}`);
    const lowerMessage = message.toLowerCase();
    const calendarKeywords = [ 
      'hora', 'turno', 'disponibilidad', 'agenda', 'cuando', 'horario', 
      'disponible', 'libre', 'atiendes', 'ver', 'revisar', 'chequear', 'consultar',
      'lunes', 'martes', 'miercoles', 'miércoles', 'jueves', 'viernes', 'sabado', 'sábado', 'domingo',
      'hoy', 'mañana', 'tarde', 'a las', 'para el', 'tienes algo', 'hay espacio', 
      'agendar', 'agendamiento',
      'proxima semana', 'próxima semana', 'prixima semana', 'procsima semana', 'proxima semama',
      'proximo', 'próximo', 'priximo', 'procsimo'
    ];
    const isCalendarQuery = calendarKeywords.some(keyword => lowerMessage.includes(keyword));

    if (isCalendarQuery) {
      console.log(`⏳ Detectada consulta de calendario para ${requestClientId}`);
      let calendar; 

      if (clientConfigData && clientConfigData.googleCalendarConnected && clientConfigData.googleCalendarTokens) {
        console.log(`INFO: Cliente ${requestClientId} tiene Google Calendar conectado. Email: ${clientConfigData.googleCalendarEmail || 'No disponible en config'}. Intentando usar sus tokens.`);
        try {
          const oauth2Client = new google.auth.OAuth2(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET,
            process.env.GOOGLE_REDIRECT_URI 
          );
          oauth2Client.setCredentials(clientConfigData.googleCalendarTokens);

          if (clientConfigData.googleCalendarTokens.refresh_token && 
              clientConfigData.googleCalendarTokens.expiry_date &&
              new Date().getTime() > (clientConfigData.googleCalendarTokens.expiry_date - 5 * 60 * 1000)) {
            console.log(`INFO: Access token para ${requestClientId} (Email: ${clientConfigData.googleCalendarEmail}) expirado o por expirar. Intentando refrescar...`);
            try {
                const { credentials } = await oauth2Client.refreshAccessToken();
                oauth2Client.setCredentials(credentials); 
                await db.collection("clients").doc(requestClientId).set(
                    { googleCalendarTokens: credentials, googleCalendarLastSync: new Date().toISOString(), googleCalendarError: null },
                    { merge: true }
                );
                console.log(`INFO: Access token refrescado y actualizado en Firestore para ${requestClientId}.`);
                clientConfigData.googleCalendarTokens = credentials; 
            } catch (refreshError) {
                console.error(`ERROR: No se pudo refrescar el access token para ${requestClientId} (Email: ${clientConfigData.googleCalendarEmail}):`, refreshError.message);
                await db.collection("clients").doc(requestClientId).set(
                    { 
                        googleCalendarConnected: false, 
                        googleCalendarError: `Error al refrescar token: ${refreshError.message}. Por favor, reconecta tu calendario.`,
                        googleCalendarTokens: null 
                    },
                    { merge: true }
                );
                console.warn(`WARN: Calendario desconectado para ${requestClientId} debido a error al refrescar token. Usando calendario por defecto.`);
                calendar = await getDefaultCalendarClient(); 
            }
          }
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
        calendar = await getDefaultCalendarClient();
      }

      if (!calendar || typeof calendar.events?.list !== 'function') {
        console.error("ERROR: Cliente de calendario (ya sea del usuario o default) no está disponible o es inválido para", requestClientId);
        const errorMsg = "Lo siento, estoy teniendo problemas para acceder a la información de horarios en este momento. Por favor, intenta más tarde.";
        if (typeof logRigbotMessage === "function") { try { await logRigbotMessage({ role: "assistant", content: errorMsg, sessionId: currentSessionId, ip: ipAddress, clientId: requestClientId }); } catch(e){console.error("Log Error:",e)} }
        return res.status(503).json({ response: errorMsg }); 
      }

      const serverNowUtc = new Date();
      let targetDateForDisplay = null; 
      let targetDateIdentifierForSlotFilter = null;
      let targetHourChile = null;
      let targetMinuteChile = 0;
      let timeOfDay = null; 
      let isGenericNextWeekSearch = false;
      let specificDateParsed = false;

      const currentYearChile = parseInt(new Intl.DateTimeFormat('en-US', { year: 'numeric', timeZone: 'America/Santiago' }).format(serverNowUtc), 10);
      const currentMonthChile = parseInt(new Intl.DateTimeFormat('en-US', { month: 'numeric', timeZone: 'America/Santiago' }).format(serverNowUtc), 10) -1; 
      const currentDayOfMonthChile = parseInt(new Intl.DateTimeFormat('en-US', { day: 'numeric', timeZone: 'America/Santiago' }).format(serverNowUtc), 10);
      const todayChile0000UtcTimestamp = Date.UTC(currentYearChile, currentMonthChile, currentDayOfMonthChile, 0 - CHILE_UTC_OFFSET_HOURS, 0, 0, 0);
      const refDateForTargetCalc = new Date(todayChile0000UtcTimestamp); 
      const actualCurrentDayOfWeekInChile = refDateForTargetCalc.getUTCDay(); 
      const TOMORROW_DATE_IDENTIFIER_CHILE = getDayIdentifier(new Date(refDateForTargetCalc.getTime() + 24*60*60*1000), 'America/Santiago');
      
      const specificDateRegex = /(?:(\b(?:lunes|martes|mi[ée]rcoles|jueves|viernes|s[áa]bado|domingo)\b),?\s+)?(\d{1,2})(?:\s+de)?\s+(\b(?:ene(?:ro)?|feb(?:rero)?|mar(?:zo)?|abr(?:il)?|may(?:o)?|jun(?:io)?|jul(?:io)?|ago(?:sto)?|sep(?:tiembre)?|set(?:iembre)?|oct(?:ubre)?|nov(?:iembre)?|dic(?:iembre)?)\b)/i;
      const specificDateMatch = lowerMessage.match(specificDateRegex);

      if (specificDateMatch) {
          try {
              const dayNumber = parseInt(specificDateMatch[2], 10);
              const monthName = specificDateMatch[3].toLowerCase().substring(0, 3); 
              const monthIndex = monthMap[monthName];

              if (monthIndex !== undefined && dayNumber >= 1 && dayNumber <= 31) {
                  let yearToUse = currentYearChile;
                  if (monthIndex < currentMonthChile || (monthIndex === currentMonthChile && dayNumber < currentDayOfMonthChile)) {
                      yearToUse = currentYearChile + 1;
                  }
                  targetDateForDisplay = new Date(Date.UTC(yearToUse, monthIndex, dayNumber, 0 - CHILE_UTC_OFFSET_HOURS, 0, 0, 0));
                  if (targetDateForDisplay.getUTCMonth() === monthIndex && targetDateForDisplay.getUTCDate() === dayNumber) {
                    specificDateParsed = true;
                    targetHourChile = null; 
                    timeOfDay = null;       
                    isGenericNextWeekSearch = false; 
                    console.log(`DEBUG: Fecha específica parseada: ${targetDateForDisplay.toISOString()} para el clientId: ${requestClientId}`);
                  } else {
                    console.warn(`DEBUG: Fecha parseada ${dayNumber}/${monthName} (${monthIndex})/${yearToUse} resultó en una fecha inválida, se ignora. ClientId: ${requestClientId}`);
                    targetDateForDisplay = null; 
                  }
              }
          } catch (e) {
              console.error(`Error parseando fecha específica para ${requestClientId}:`, e);
              targetDateForDisplay = null; 
          }
      }
      
      const isProximoWordQuery = calendarKeywords.some(k => k.startsWith("proximo") && lowerMessage.includes(k));
      const isAnyNextWeekIndicator = calendarKeywords.some(k => k.includes("semana") && lowerMessage.includes(k));
      let dayKeywordFound = false; 
      let specificDayKeywordIndex = -1;
      const dayKeywordsList = [ 
        { keyword: 'domingo', index: 0 }, { keyword: 'lunes', index: 1 }, { keyword: 'martes', index: 2 }, 
        { keyword: 'miercoles', index: 3 }, { keyword: 'miércoles', index: 3 }, { keyword: 'jueves', index: 4 }, 
        { keyword: 'viernes', index: 5 }, { keyword: 'sabado', index: 6 }, { keyword: 'sábado', index: 6 }
      ];

      if (!specificDateParsed) { 
        for (const dayInfo of dayKeywordsList) { 
            if (lowerMessage.includes(dayInfo.keyword)) { 
                specificDayKeywordIndex = dayInfo.index;
                dayKeywordFound = true; 
                break; 
            } 
        }
      }
      
      if (specificDateParsed) {
        // Date already set.
      } else if (dayKeywordFound) { 
        targetDateForDisplay = new Date(refDateForTargetCalc);
        let daysToAdd = specificDayKeywordIndex - actualCurrentDayOfWeekInChile;
        if (isProximoWordQuery) {
            if (daysToAdd < 0) { daysToAdd += 7; }
            if (daysToAdd < 7) { daysToAdd += 7; }
        } else { 
            if (daysToAdd < 0) { daysToAdd += 7; }
            if (isAnyNextWeekIndicator && daysToAdd < 7) { daysToAdd += 7;}
            else if (daysToAdd === 0 && serverNowUtc.getUTCHours() >= (19 - CHILE_UTC_OFFSET_HOURS)) { daysToAdd += 7; }
        }
        targetDateForDisplay.setUTCDate(targetDateForDisplay.getUTCDate() + daysToAdd);
      } else if (lowerMessage.includes('hoy')) { 
        targetDateForDisplay = new Date(refDateForTargetCalc);
      } else if (lowerMessage.includes('mañana') && !lowerMessage.includes('pasado mañana')) { 
        const isJustTomorrowDayQuery = /\bmañana\b(?![\wáéíóú])/i.test(lowerMessage) && !lowerMessage.match(/\b(en|por)\s+la\s+mañana\b/i);
        if (isJustTomorrowDayQuery || !dayKeywordFound) { 
            targetDateForDisplay = new Date(refDateForTargetCalc);
            targetDateForDisplay.setUTCDate(targetDateForDisplay.getUTCDate() + 1);
        } else if (dayKeywordFound && targetDateForDisplay === null) { 
             console.log("DEBUG: 'mañana' (palabra) presente pero targetDateForDisplay no se seteó y dayKeywordFound era true. Revisar lógica.");
        }
      } else if (isAnyNextWeekIndicator) { 
          targetDateForDisplay = new Date(refDateForTargetCalc);
          let daysUntilNextMonday = (1 - actualCurrentDayOfWeekInChile + 7) % 7;
          if (daysUntilNextMonday === 0 && !isProximoWordQuery) daysUntilNextMonday = 7; 
          targetDateForDisplay.setUTCDate(targetDateForDisplay.getUTCDate() + daysUntilNextMonday); 
          isGenericNextWeekSearch = true; 
      }
      
      if (targetDateForDisplay) {
        console.log(`🎯 Fecha Objetivo (para mostrar y filtrar) para ${requestClientId}: ${new Intl.DateTimeFormat('es-CL', { dateStyle: 'full', timeZone: 'America/Santiago' }).format(targetDateForDisplay)} (UTC: ${targetDateForDisplay.toISOString()})`);
        const futureLimitCheckDate = new Date(refDateForTargetCalc); 
        futureLimitCheckDate.setUTCDate(futureLimitCheckDate.getUTCDate() + effectiveConfig.calendarMaxUserRequestDays);
        if (targetDateForDisplay >= futureLimitCheckDate) {
            const formattedDateAsked = new Intl.DateTimeFormat('es-CL', { dateStyle: 'long', timeZone: 'America/Santiago' }).format(targetDateForDisplay);
            let reply = `¡Entiendo que buscas para el ${formattedDateAsked}! 😊 Por ahora, mi calendario mental solo llega hasta unos ${effectiveConfig.calendarMaxUserRequestDays} días en el futuro.${getWhatsappContactMessage(effectiveConfig.whatsappNumber)} y mis colegas humanos te ayudarán con gusto.`;
            console.log('✅ Respuesta generada (fecha demasiado lejana):', reply);
            if (typeof logRigbotMessage === "function") { try { await logRigbotMessage({ role: "assistant", content: reply, sessionId: currentSessionId, ip: ipAddress, clientId: requestClientId }); } catch(e){console.error("Log Error:",e)} }
            return res.status(200).json({ response: reply }); 
        }
      }
      
      targetDateIdentifierForSlotFilter = (targetDateForDisplay && !isGenericNextWeekSearch) ? getDayIdentifier(targetDateForDisplay, 'America/Santiago') : null;
      if(targetDateIdentifierForSlotFilter) { console.log(`🏷️ Identificador de Fecha para Filtro de Slots (Chile YAML-MM-DD) para ${requestClientId}: ${targetDateIdentifierForSlotFilter}`); } 
      else if (targetDateForDisplay && isGenericNextWeekSearch) { console.log(`🏷️ Búsqueda genérica para ${requestClientId} para la semana que comienza el ${getDayIdentifier(targetDateForDisplay, 'America/Santiago')}, sin filtro de día específico.`); } 
      else { console.log(`🏷️ Búsqueda genérica desde hoy para ${requestClientId}, sin filtro de día específico.`); }
      
      if (targetHourChile === null) { 
        const tardePattern = /\b(tarde|de tarde|en la tarde)\b/i;
        const mananaPattern = /\b(mañana|de mañana|en la mañana)\b/i; 

        if (tardePattern.test(lowerMessage)) {
            timeOfDay = 'afternoon';
        } else if (mananaPattern.test(lowerMessage)) {
            const isTargetToday = targetDateForDisplay && getDayIdentifier(targetDateForDisplay, 'America/Santiago') === getDayIdentifier(refDateForTargetCalc, 'America/Santiago');
            const isTargetTomorrowDayByDate = targetDateForDisplay && getDayIdentifier(targetDateForDisplay, 'America/Santiago') === TOMORROW_DATE_IDENTIFIER_CHILE;
            
            if (!targetDateForDisplay || isTargetToday || isTargetTomorrowDayByDate || dayKeywordFound || specificDateParsed ) {
                timeOfDay = 'morning';
            }
        }
        if(timeOfDay) console.log(`🕒 Franja horaria parseada para ${requestClientId}: ${timeOfDay}`);
      }

      const timeMatch = lowerMessage.match(/(\d{1,2})\s*(:(00|30|15|45))?\s*(pm|am|h|hr|hrs)?/i);
      if (timeMatch) {
        let hour = parseInt(timeMatch[1], 10);
        let minute = timeMatch[3] ? parseInt(timeMatch[3], 10) : 0; 
        const isPm = timeMatch[4] && timeMatch[4].toLowerCase() === 'pm';
        const isAm = timeMatch[4] && timeMatch[4].toLowerCase() === 'am';
        if (isPm && hour >= 1 && hour <= 11) hour += 12;
        if (isAm && hour === 12) hour = 0; 
        
        if (!specificDateParsed || (specificDateParsed && (timeMatch[2] || timeMatch[4]))) {
            targetHourChile = hour;
            targetMinuteChile = minute;
            if (targetMinuteChile > 0 && targetMinuteChile < 15) targetMinuteChile = 0; 
            else if (targetMinuteChile >= 15 && targetMinuteChile < 30) targetMinuteChile = 0; 
            else if (targetMinuteChile > 30 && targetMinuteChile < 45) targetMinuteChile = 30; 
            else if (targetMinuteChile >= 45 && targetMinuteChile < 60) targetMinuteChile = 30;
            timeOfDay = null; 
            console.log(`⏰ Hora objetivo (Chile) parseada por timeMatch para ${requestClientId}: ${targetHourChile}:${targetMinuteChile.toString().padStart(2,'0')}`);
        } else if (specificDateParsed) {
            console.log(`DEBUG: timeMatch capturó un número (${timeMatch[1]}) pero se ignoró porque specificDateParsed era true y no había indicadores claros de hora (am/pm, h, :xx). ClientId: ${requestClientId}`);
        }
      }

      if (specificDateParsed && targetHourChile !== null && timeMatch && !timeMatch[2] && !timeMatch[4]) {
          console.log(`DEBUG: Reseteando targetHourChile (${targetHourChile}) porque probablemente vino del número del día de una fecha específica parseada. Captura original de timeMatch: ${timeMatch[0]} para el clientId: ${requestClientId}`);
          targetHourChile = null;
          targetMinuteChile = 0; 
          const tardePattern = /\b(tarde|de tarde|en la tarde)\b/i;
          const mananaPattern = /\b(mañana|de mañana|en la mañana)\b/i;
          if (tardePattern.test(lowerMessage)) timeOfDay = 'afternoon';
          else if (mananaPattern.test(lowerMessage)) timeOfDay = 'morning';
          if(timeOfDay) console.log(`🕒 Franja horaria RE-EVALUADA para ${requestClientId}: ${timeOfDay}`);
      }
      
      const WORKING_HOURS_CHILE_NUMERIC = [10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5, 14, 14.5, 15, 15.5, 16, 16.5, 17, 17.5, 18, 18.5, 19, 19.5];
      if (targetHourChile !== null) { 
        const requestedTimeNumeric = targetHourChile + (targetMinuteChile / 60);
        if (!WORKING_HOURS_CHILE_NUMERIC.includes(requestedTimeNumeric) || requestedTimeNumeric < 10 || requestedTimeNumeric > 19.5) {
            let replyPreamble = `¡Ojo! 👀 Parece que las ${targetHourChile.toString().padStart(2,'0')}:${targetMinuteChile.toString().padStart(2,'0')}`;
            if (targetDateForDisplay) { 
                replyPreamble = `¡Ojo! 👀 Parece que el ${new Intl.DateTimeFormat('es-CL', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Santiago' }).format(targetDateForDisplay)} a las ${targetHourChile.toString().padStart(2,'0')}:${targetMinuteChile.toString().padStart(2,'0')}`;
            }
            let reply = `${replyPreamble} está fuera de nuestro horario de atención (${effectiveConfig.horario}). ¿Te gustaría buscar dentro de ese rango?${getWhatsappContactMessage(effectiveConfig.whatsappNumber)}`;
            console.log('✅ Respuesta generada (fuera de horario):', reply);
            if (typeof logRigbotMessage === "function") { try { await logRigbotMessage({ role: "assistant", content: reply, sessionId: currentSessionId, ip: ipAddress, clientId: requestClientId }); } catch(e){console.error("Log Error:",e)} }
            return res.status(200).json({ response: reply });
        }
      }

      let calendarQueryStartUtc;
      if (targetDateForDisplay) { calendarQueryStartUtc = new Date(targetDateForDisplay.getTime());} 
      else { calendarQueryStartUtc = new Date(refDateForTargetCalc.getTime()); } 
      
      if (!targetDateForDisplay && calendarQueryStartUtc < serverNowUtc && 
          getDayIdentifier(calendarQueryStartUtc, 'America/Santiago') === getDayIdentifier(serverNowUtc, 'America/Santiago')) {
            const tempTomorrow = new Date(refDateForTargetCalc);
            tempTomorrow.setUTCDate(tempTomorrow.getUTCDate() + 1);
            if (calendarQueryStartUtc < serverNowUtc ) { 
                 const currentChileHour = parseInt(new Intl.DateTimeFormat('en-US', {hour:'2-digit', hour12: false, timeZone:'America/Santiago'}).format(serverNowUtc));
                 if (currentChileHour >= 19) { 
                    console.log("DEBUG: Query genérica para hoy pero es tarde, iniciando búsqueda desde mañana.")
                    calendarQueryStartUtc = tempTomorrow;
                 }
            }
      }

      const calendarQueryEndUtc = new Date(calendarQueryStartUtc);
      calendarQueryEndUtc.setUTCDate(calendarQueryStartUtc.getUTCDate() + effectiveConfig.calendarQueryDays); 
      console.log(`🗓️ Google Calendar Query para ${requestClientId} (Calendario: ${clientConfigData?.googleCalendarConnected && clientConfigData.googleCalendarEmail ? clientConfigData.googleCalendarEmail : (clientConfigData?.googleCalendarConnected ? 'Cliente (email no obtenido)' : 'Default')}): De ${calendarQueryStartUtc.toISOString()} a ${calendarQueryEndUtc.toISOString()}`);

      let googleResponse;
      try {
        console.log(`DEBUG: Intentando llamar a calendar.events.list para ${requestClientId}...`);
        googleResponse = await calendar.events.list({
          calendarId: 'primary', 
          timeMin: calendarQueryStartUtc.toISOString(),
          timeMax: calendarQueryEndUtc.toISOString(),
          singleEvents: true,
          orderBy: 'startTime'
        });
        console.log(`DEBUG: Llamada a calendar.events.list completada para ${requestClientId}.`);
      } catch (googleError) {
        console.error(`❌ ERROR DIRECTO en calendar.events.list para ${requestClientId}:`, googleError);
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
      const busySlots = eventsFromGoogle.filter(e => e.status !== 'cancelled')
        .map(e => {
          if (e.start?.dateTime && e.end?.dateTime) { 
            return { start: new Date(e.start.dateTime).getTime(), end: new Date(e.end.dateTime).getTime() };
          }
          return null; 
        }).filter(Boolean); 
      console.log(`INFO: Se obtuvieron ${eventsFromGoogle.length} eventos y se procesaron ${busySlots.length} busy slots (ignorando all-day) del calendario para ${requestClientId}.`);
      
      const WORKING_HOURS_CHILE_STR = [
        '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30',
        '14:00', '14:30', '15:00', '15:30', '16:00', '16:30', '17:00', '17:30',
        '18:00', '18:30', '19:00', '19:30'
      ];
      const availableSlotsOutput = []; 
      const processedDaysForGenericQuery = new Set();       
      let baseIterationDateDayUtcStart;
 
      if (targetDateForDisplay) { 
          baseIterationDateDayUtcStart = new Date(targetDateForDisplay); 
      } else { 
          baseIterationDateDayUtcStart = new Date(calendarQueryStartUtc); 
      }

      console.log(`DEBUG: Iniciando bucle de ${effectiveConfig.calendarQueryDays} días para ${requestClientId}. Base UTC para iteración: ${baseIterationDateDayUtcStart.toISOString()}`);
      for (let i = 0; i < effectiveConfig.calendarQueryDays; i++) {
        const currentDayProcessingUtcStart = new Date(baseIterationDateDayUtcStart);
        currentDayProcessingUtcStart.setUTCDate(baseIterationDateDayUtcStart.getUTCDate() + i);
        const currentDayProcessingIdentifierChile = getDayIdentifier(currentDayProcessingUtcStart, 'America/Santiago');
        
        const isCurrentDayTomorrow = currentDayProcessingIdentifierChile === TOMORROW_DATE_IDENTIFIER_CHILE;
        let isDebuggingThisSpecificSlotIteration = false; // Variable de bandera para los logs detallados

        // Condición para activar logs detallados solo para Jueves 3pm
        if (targetHourChile === 15 && targetMinuteChile === 0 && isCurrentDayTomorrow) {
            isDebuggingThisSpecificSlotIteration = true; 
            console.log(`\n🔍 DEBUGGING "MAÑANA JUEVES 3PM" SLOT PROCESSING (ClientId: ${requestClientId}):`);
            console.log(`   Current Day (Chile): ${currentDayProcessingIdentifierChile}, Slot Time (Chile) being checked: 15:00`);
            console.log(`   User's Target Hour/Minute (Chile): ${targetHourChile}:${targetMinuteChile}`);
        } else if (process.env.NODE_ENV === 'development') { // Log general para otros casos solo en dev
           console.log(`\nDEBUG: Bucle Día i=${i} para ${requestClientId}. Iterando para día UTC: ${currentDayProcessingUtcStart.toISOString()} (Corresponde al día de Chile: ${currentDayProcessingIdentifierChile})`);
            if (targetDateIdentifierForSlotFilter) {
                 console.log(`DEBUG: comparando con targetDateIdentifierForSlotFilter para ${requestClientId}: ${targetDateIdentifierForSlotFilter}`);
            }
        }

        for (const timeChileStr of WORKING_HOURS_CHILE_STR) {
          const [hChile, mChile] = timeChileStr.split(':').map(Number);
          let skipReason = ""; 
          if (targetHourChile !== null) { 
              if (hChile !== targetHourChile || mChile !== targetMinuteChile) { skipReason = "Filtro de hora específica"; }
          } else if (timeOfDay) { 
            if (timeOfDay === 'morning' && (hChile < 10 || hChile >= 14)) skipReason = "Filtro franja mañana";
            if (timeOfDay === 'afternoon' && (hChile < 14 || hChile > 19 || (hChile === 19 && mChile > 30))) skipReason = "Filtro franja tarde";
          }
          
          const isCurrentHourTheSpecificDebugHour = (isDebuggingThisSpecificSlotIteration && hChile === 15 && mChile === 0);
          if (skipReason && !isCurrentHourTheSpecificDebugHour ) { continue; } 

          const slotStartUtc = convertChileTimeToUtc(currentDayProcessingUtcStart, hChile, mChile);
          const slotDayIdentifierInChile = getDayIdentifier(slotStartUtc, 'America/Santiago');
          if (isNaN(slotStartUtc.getTime())) { console.log(`    DESCARTADO para ${requestClientId}: Slot UTC inválido.`); continue; }
          const slightlyFutureServerNowUtc = new Date(serverNowUtc.getTime() + 1 * 60 * 1000); 
          if (slotStartUtc < slightlyFutureServerNowUtc && !isCurrentHourTheSpecificDebugHour) { continue; } 

          if (targetDateIdentifierForSlotFilter) { 
            if (slotDayIdentifierInChile !== targetDateIdentifierForSlotFilter) {
              continue; 
            }
          }
          const slotEndUtc = new Date(slotStartUtc);
          slotEndUtc.setUTCMinutes(slotEndUtc.getUTCMinutes() + 30);
          const isBusy = busySlots.some(busy => slotStartUtc.getTime() < busy.end && slotEndUtc.getTime() > busy.start);
          
          if (isCurrentHourTheSpecificDebugHour) { // Solo para el slot 15:00 del Jueves 29
            console.log(`   DEBUG JUEVES 3PM: slotStartUtc=${slotStartUtc.toISOString()}, isBusy=${isBusy}`);
            if (targetHourChile !== null) { 
                const conditionMatches = (hChile === targetHourChile && mChile === targetMinuteChile);
                console.log(`   DEBUG JUEVES 3PM: Condition (hChile === targetHourChile && mChile === targetMinuteChile) is: ${conditionMatches}`);
                if (!isBusy && conditionMatches) {
                    console.log(`   DEBUG JUEVES 3PM: ✅ This slot SHOULD be added to availableSlotsOutput for specific time query.`);
                } else if (isBusy) {
                    console.log(`   DEBUG JUEVES 3PM: ❌ This slot is busy, so it won't be added.`);
                } else if (!conditionMatches) { 
                    console.log(`   DEBUG JUEVES 3PM: ❌ Hour/minute mismatch, so it won't be added for specific time query.`);
                }
            }
            console.log(`   DEBUG JUEVES 3PM: Busy slots around this time for ${currentDayProcessingIdentifierChile} (raw from Google, times in UTC):`);
            busySlots.forEach(bs => {
                const busyStart = new Date(bs.start);
                const busyEnd = new Date(bs.end);
                if (busyStart.getUTCFullYear() === currentDayProcessingUtcStart.getUTCFullYear() &&
                    busyStart.getUTCMonth() === currentDayProcessingUtcStart.getUTCMonth() &&
                    busyStart.getUTCDate() === currentDayProcessingUtcStart.getUTCDate()) {
                    // slotStartUtc y slotEndUtc aquí son los del slot actual de 15:00 que estamos debuggeando
                    if (slotStartUtc.getTime() < busyEnd.getTime() && slotEndUtc.getTime() > busyStart.getTime()) {
                         console.log(`     - RELEVANTE Busy (para el slot ${hChile}:${mChile}): ${busyStart.toISOString()} to ${busyEnd.toISOString()}`);
                    }
                }
            });
            console.log(`🔍 END DEBUGGING "MAÑANA JUEVES 3PM" SLOT PROCESSING (Loop iteration)\n`);
          }
          // Re-aplicar skipReasons después de los logs de debug para el slot específico
          if (skipReason && !isCurrentHourTheSpecificDebugHour) continue; 
          if (slotStartUtc < slightlyFutureServerNowUtc && !isCurrentHourTheSpecificDebugHour) continue; 


          if (!isBusy) { 
            const formattedSlot = new Intl.DateTimeFormat('es-CL', {weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'America/Santiago'}).format(slotStartUtc);
            availableSlotsOutput.push(formattedSlot); 
          } 
        } 
        if (targetDateIdentifierForSlotFilter && getDayIdentifier(currentDayProcessingUtcStart, 'America/Santiago') === targetDateIdentifierForSlotFilter) {
            if (availableSlotsOutput.length >= effectiveConfig.maxSuggestions && !targetHourChile ) break; 
            const specificSlotWasFound = availableSlotsOutput.find(slot => {
                const normalizedSlotStr = slot.replace(/[\s\u00A0\u202F]+/g, ' '); // Normalizar espacios
                const timePartMatch = normalizedSlotStr.match(/(\d{1,2}:\d{2})\s(a\.?m\.?|p\.?m\.?)/i);
                if (timePartMatch && targetHourChile !==null) {
                    const slotHourMin = timePartMatch[1]; 
                    let [slotH, slotM] = slotHourMin.split(':').map(Number); 
                    const slotPeriod = timePartMatch[2] ? timePartMatch[2].toLowerCase().replace(/\./g,'').trim() : null;
                    if (slotPeriod) {
                        if (slotPeriod === 'pm' && slotH >= 1 && slotH <= 11) slotH += 12; 
                        if (slotPeriod === 'am' && slotH === 12) slotH = 0; 
                    }
                    return slotH === targetHourChile && slotM === targetMinuteChile;
                } return false;
            });
            if (targetHourChile !== null && specificSlotWasFound) break; 
            if (targetHourChile !== null && i === 0 && !specificSlotWasFound ) break; 
        }
        if (availableSlotsOutput.length >= effectiveConfig.maxSuggestions && !targetDateIdentifierForSlotFilter && !targetHourChile && processedDaysForGenericQuery.size >=2) break; 
      } 
      
      // Condición para activar logs de RESPONSE PREP
      const isDebuggingQueryForResponsePrep = (targetHourChile === 15 && targetMinuteChile === 0 && 
                                              (targetDateIdentifierForSlotFilter === TOMORROW_DATE_IDENTIFIER_CHILE || 
                                              (targetDateForDisplay && getDayIdentifier(targetDateForDisplay, 'America/Santiago') === TOMORROW_DATE_IDENTIFIER_CHILE ) ) 
                                             );
      if (isDebuggingQueryForResponsePrep) { 
        console.log(`\n🔍 DEBUGGING "MAÑANA JUEVES 3PM" RESPONSE PREP (ClientId: ${requestClientId}):`);
        console.log(`   targetHourChile: ${targetHourChile}, targetMinuteChile: ${targetMinuteChile}`);
        console.log(`   targetDateIdentifierForSlotFilter: ${targetDateIdentifierForSlotFilter}`);
        console.log(`   AvailableSlotsOutput before .find() for requestedSlotExactMatch (length ${availableSlotsOutput.length}):`);
        availableSlotsOutput.forEach((s, idx) => console.log(`    - Slot ${idx}: "${s}" (length: ${s.length})`));
        console.log(`🔍 END DEBUGGING "MAÑANA JUEVES 3PM" RESPONSE PREP\n`);
      }
      if(targetDateIdentifierForSlotFilter) { console.log(`🔎 Slots encontrados para ${requestClientId} el día de Chile ${targetDateIdentifierForSlotFilter}: ${availableSlotsOutput.length} (después del bucle, antes de formateo final)`); } 
      else { console.log(`🔎 Slots encontrados para ${requestClientId} en búsqueda genérica (próximos ${effectiveConfig.calendarQueryDays} días): ${availableSlotsOutput.length} (después del bucle, antes de formateo final)`); }
      
      let replyCalendar = ''; 
      const slightlyFutureServerNowUtcForResponse = new Date(serverNowUtc.getTime() + 1 * 60 * 1000); 

      if (targetHourChile !== null) { 
        let specificTimeQueryFormattedForMsg = "";
        const displayDateForMsg = targetDateForDisplay || refDateForTargetCalc; 
        specificTimeQueryFormattedForMsg += `${new Intl.DateTimeFormat('es-CL', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Santiago' }).format(displayDateForMsg)} `;
        specificTimeQueryFormattedForMsg += `a las ${targetHourChile.toString().padStart(2,'0')}:${targetMinuteChile.toString().padStart(2,'0')}`;

        const requestedSlotExactMatch = availableSlotsOutput.find(slotString => {
            const isTargetingForFindCBLog = (targetHourChile === 15 && targetMinuteChile === 0 && 
                                             (targetDateIdentifierForSlotFilter === TOMORROW_DATE_IDENTIFIER_CHILE || 
                                             (targetDateForDisplay && getDayIdentifier(targetDateForDisplay, 'America/Santiago') === TOMORROW_DATE_IDENTIFIER_CHILE ) ) );
            if (isTargetingForFindCBLog) {
                console.log(`🔍 DEBUG FIND CB [Slot String]: "${slotString}" (length: ${slotString.length})`);
            }
            const normalizedSlotString = slotString.replace(/[\s\u00A0\u202F]+/g, ' ');
            const timePartMatch = normalizedSlotString.match(/(\d{1,2}:\d{2})\s(a\.?m\.?|p\.?m\.?)/i); 
            
            if (isTargetingForFindCBLog) {
                console.log(`🔍 DEBUG FIND CB: Normalized string for regex: "${normalizedSlotString}"`);
                console.log(`🔍 DEBUG FIND CB: timePartMatch (using /(\\d{1,2}:\\d{2})\\s(a\\.?m\\.?|p\\.?m\\.?)/i ):`, timePartMatch);
            }

            if (timePartMatch) {
                const slotHourMin = timePartMatch[1]; 
                let [slotH, slotM] = slotHourMin.split(':').map(Number); 
                const slotPeriod = timePartMatch[2] ? timePartMatch[2].toLowerCase().replace(/\./g, '').trim() : null;

                if (isTargetingForFindCBLog) {
                    console.log(`🔍 DEBUG FIND CB: slotH=${slotH}, slotM=${slotM}, slotPeriod="${slotPeriod}" (original from regex: "${timePartMatch[2]}")`);
                }
                
                if (slotPeriod) { 
                    if (slotPeriod === 'pm' && slotH >= 1 && slotH <= 11) slotH += 12; 
                    if (slotPeriod === 'am' && slotH === 12) slotH = 0; 
                }

                if (isTargetingForFindCBLog) {
                    console.log(`🔍 DEBUG FIND CB: slotH convertido=${slotH}. Comparando con targetHourChile=${targetHourChile}`);
                }
                const match = (slotH === targetHourChile && slotM === targetMinuteChile);
                if (isTargetingForFindCBLog) {
                     console.log(`🔍 DEBUG FIND CB: Resultado de la comparación: ${match}`);
                }
                return match;
            }
            if (isTargetingForFindCBLog) {
                console.log(`🔍 DEBUG FIND CB: timePartMatch fue null para "${normalizedSlotString}".`);
            }
            return false;
        });
        
        if (isStillDebuggingThisQuery) { // Re-usar la variable de arriba para el log del resultado final del find
            console.log("🔍 DEBUG FIND: Resultado de requestedSlotExactMatch:", requestedSlotExactMatch);
        }

        if (requestedSlotExactMatch) { 
          replyCalendar = `¡Excelente! 🎉 Justo el ${requestedSlotExactMatch} está libre para ti.${getWhatsappDerivationSuffix(effectiveConfig.whatsappNumber)} 😉`;
        } else { 
            replyCalendar = `¡Uy! Justo ${specificTimeQueryFormattedForMsg} no me quedan espacios. 😕`;
            let alternativesForTheDay = [];
            const dayToSearchAlternatives = targetDateForDisplay || refDateForTargetCalc;

            if (dayToSearchAlternatives) {
                const shouldLogAlternativesSearch = (targetHourChile === 15 && targetMinuteChile === 0 && 
                                                    (getDayIdentifier(dayToSearchAlternatives, 'America/Santiago') === TOMORROW_DATE_IDENTIFIER_CHILE)) 
                                                    || process.env.NODE_ENV === 'development';

                if (shouldLogAlternativesSearch){ 
                    console.log(`DEBUG: Hora específica ${targetHourChile}:${targetMinuteChile} no disponible para ${getDayIdentifier(dayToSearchAlternatives, 'America/Santiago')}. Buscando alternativas para ese día. ClientId: ${requestClientId}`);
                }
                for (const timeChileStr of WORKING_HOURS_CHILE_STR) {
                    const [hC, mC] = timeChileStr.split(':').map(Number);
                    if (hC === targetHourChile && mC === targetMinuteChile) continue; 

                    const slotStartUtcAlt = convertChileTimeToUtc(dayToSearchAlternatives, hC, mC);
                    if (slotStartUtcAlt < slightlyFutureServerNowUtcForResponse) continue; 
                    
                    const slotEndUtcAlt = new Date(slotStartUtcAlt);
                    slotEndUtcAlt.setUTCMinutes(slotEndUtcAlt.getUTCMinutes() + 30);
                    const isBusyAlt = busySlots.some(busy => slotStartUtcAlt.getTime() < busy.end && slotEndUtcAlt.getTime() > busy.start);
                    
                    if (!isBusyAlt) {
                        alternativesForTheDay.push(new Intl.DateTimeFormat('es-CL', {
                            weekday: 'long', day: 'numeric', month: 'long',
                            hour: '2-digit', minute: '2-digit', timeZone: 'America/Santiago'
                        }).format(slotStartUtcAlt));
                    }
                    if (alternativesForTheDay.length >= effectiveConfig.maxSuggestions) break;
                }
            }

            if (alternativesForTheDay.length > 0) {
                replyCalendar += ` Pero para el ${new Intl.DateTimeFormat('es-CL', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Santiago' }).format(dayToSearchAlternatives)} tengo estas otras opciones:\n- ${alternativesForTheDay.join('\n- ')}`;
            } else if (targetDateForDisplay){ 
                replyCalendar += ` Y no encuentro más horarios disponibles para ese día.`;
            }
            replyCalendar += ` ¿Te animas a que busquemos en otra fecha u horario?${getWhatsappContactMessage(effectiveConfig.whatsappNumber)}`;
        }
      } else if (availableSlotsOutput.length > 0) { 
// ... (resto del código SIN CAMBIOS DESDE AQUÍ) ...
        let intro = `¡Buenas noticias! 🎉 Encontré estas horitas disponibles`;
        if (targetDateForDisplay) {
          if (isGenericNextWeekSearch) { 
            intro += ` para la próxima semana (comenzando el ${new Intl.DateTimeFormat('es-CL', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Santiago' }).format(targetDateForDisplay)})`;
          } else {
              intro += ` para el ${new Intl.DateTimeFormat('es-CL', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Santiago' }).format(targetDateForDisplay)}`;
          }
        } else if (isAnyNextWeekIndicator) { 
            intro += ` para la próxima semana`;
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
                const dayKey = slot.split(',').slice(0,2).join(','); 
                if (!slotsByDay[dayKey]) slotsByDay[dayKey] = [];
                if (slotsByDay[dayKey].length < 2) { slotsByDay[dayKey].push(slot); } 
            }
            let count = 0;
            const sortedDayKeys = Object.keys(slotsByDay).sort((a, b) => {
                try { 
                    const dateA = new Date(a.split(', ')[1].replace(/ de /g, ' ') + " " + currentYearChile);
                    const dateB = new Date(b.split(', ')[1].replace(/ de /g, ' ') + " " + currentYearChile);
                    return dateA - dateB;
                } catch(e) { return 0; }
            });
            for (const dayKey of sortedDayKeys) { 
                for(const slot of slotsByDay[dayKey]){
                    if(count < effectiveConfig.maxSuggestions){ finalSuggestions.push(slot); count++; } else { break; }
                }
                if (count >= effectiveConfig.maxSuggestions) break; 
            }
        } else { 
             finalSuggestions = availableSlotsOutput.slice(0, effectiveConfig.maxSuggestions);
        }
                
        if (finalSuggestions.length === 0 && availableSlotsOutput.length > 0) {
            finalSuggestions = availableSlotsOutput.slice(0, effectiveConfig.maxSuggestions);
        }
        
        if (finalSuggestions.length > 0) {
            replyCalendar = `${intro}\n- ${finalSuggestions.join('\n- ')}`;
            if (availableSlotsOutput.length > finalSuggestions.length && finalSuggestions.length > 0 && finalSuggestions.length < effectiveConfig.maxSuggestions) { 
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
            replyCalendar += `. ¿Te animas a que busquemos en otra fecha u horario?${getWhatsappContactMessage(effectiveConfig.whatsappNumber)} ¡Seguro te podemos ayudar!`;
        }
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
      
      console.log(`✅ Respuesta generada (Calendario) para ${requestClientId}:`, replyCalendar);
      if (typeof logRigbotMessage === "function") { try { await logRigbotMessage({ role: "assistant", content: replyCalendar, sessionId: currentSessionId, ip: ipAddress, clientId: requestClientId }); } catch(e){console.error("Log Error:",e)} }
      return res.status(200).json({ response: replyCalendar });
    } 

    console.log(`💡 Consulta normal, usando OpenAI para ${requestClientId}`);
    
    let finalSystemPrompt = effectiveConfig.basePrompt || DEFAULT_SYSTEM_PROMPT_TEMPLATE;
    finalSystemPrompt = finalSystemPrompt.replace(/\$\{DAYS_TO_QUERY_CALENDAR\}/g, String(effectiveConfig.calendarQueryDays));
    finalSystemPrompt = finalSystemPrompt.replace(/\$\{MAX_DAYS_FOR_USER_REQUEST\}/g, String(effectiveConfig.calendarMaxUserRequestDays));
    
    const wsNum = String(effectiveConfig.whatsappNumber || '').trim();
    if (wsNum && wsNum !== WHATSAPP_FALLBACK_PLACEHOLDER) {
        finalSystemPrompt = finalSystemPrompt.replace(/\$\{whatsappNumber\}/g, wsNum);
    } else {
        finalSystemPrompt = finalSystemPrompt.replace(/\$\{whatsappNumber\}/g, "nuestro principal canal de contacto telefónico o digital");
    }
    finalSystemPrompt = finalSystemPrompt.replace(/\$\{pricingInfo\}/g, String(effectiveConfig.pricingInfo));
    finalSystemPrompt = finalSystemPrompt.replace(/\$\{direccion\}/g, String(effectiveConfig.direccion));
    finalSystemPrompt = finalSystemPrompt.replace(/\$\{horario\}/g, String(effectiveConfig.horario));
    finalSystemPrompt = finalSystemPrompt.replace(/\$\{chiropracticVideoUrl\}/g, String(effectiveConfig.chiropracticVideoUrl));
    finalSystemPrompt = finalSystemPrompt.replace(/\$\{telefono\}/g, String(effectiveConfig.telefono || ""));

    console.log(`System Prompt para OpenAI (clientId: ${requestClientId}, primeros 500 chars):`, finalSystemPrompt.substring(0, 500) + "...");

    const chatResponse = await openai.chat.completions.create({
      model: MODEL_FALLBACK, 
      messages: [
        { role: 'system', content: finalSystemPrompt },
        { role: 'user', content: message }
      ]
    });

    let gptReply = chatResponse.choices[0].message.content.trim();
    
    console.log(`✅ Respuesta generada (OpenAI) para ${requestClientId}:`, gptReply);
    if (typeof logRigbotMessage === "function") { try { await logRigbotMessage({ role: "assistant", content: gptReply, sessionId: currentSessionId, ip: ipAddress, clientId: requestClientId }); } catch(e){console.error("Log Error:",e)} }
    return res.status(200).json({ response: gptReply });

  } catch (error) {
    console.error(`❌ Error en Rigbot para clientId ${requestClientId}:`, error.message, error.stack);
    const errorForUser = 'Ocurrió un error inesperado en Rigbot. Por favor, intenta más tarde.';
    if (typeof logRigbotMessage === "function") { 
        try { 
            await logRigbotMessage({ 
                role: "assistant", 
                content: `Error interno: ${error.message}. UserMsg: ${errorForUser}`, 
                sessionId: currentSessionId, 
                ip: ipAddress, 
                clientId: requestClientId 
            }); 
        } catch(eLogging){ 
            console.error("Error al loguear el error final:", eLogging);
        } 
    }
    return res.status(500).json({ 
        error: errorForUser, 
        details: process.env.NODE_ENV === 'development' ? error.message + (error.stack ? `\nStack: ${error.stack.substring(0,500)}...` : '') : undefined 
    });
  } 
}