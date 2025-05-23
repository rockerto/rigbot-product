// pages/api/chat.js
import { getCalendarClient } from '@/lib/google';
import OpenAI from 'openai';
import { logRigbotMessage } from "@/lib/rigbotLog";
import { DEFAULT_SYSTEM_PROMPT_TEMPLATE } from '@/lib/defaultSystemPromptTemplate'; // Importación del prompt externo

// --- Firebase Admin Setup ---
import { getFirestore, doc, getDoc } from 'firebase-admin/firestore';
import { initializeApp as initializeAdminApp, getApps as getAdminApps, applicationDefault } from 'firebase-admin/app';

if (!getAdminApps().length) {
  try {
    initializeAdminApp({ credential: applicationDefault() });
    console.log("Firebase Admin SDK inicializado.");
  } catch (e) {
    console.error("Error inicializando Firebase Admin SDK:", e);
  }
}
const db = getFirestore();
// --- End Firebase Admin Setup ---

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const MODEL_FALLBACK = process.env.OPENAI_MODEL || 'gpt-4o';
const CHILE_UTC_OFFSET_HOURS = -4;

// --- Default Configuration ---
const WHATSAPP_FALLBACK_PLACEHOLDER = "+56900000000"; // Un valor distintivo para el placeholder

const defaultConfig = {
  basePrompt: process.env.RIGBOT_PROMPT || DEFAULT_SYSTEM_PROMPT_TEMPLATE,
  calendarQueryDays: 7,
  calendarMaxUserRequestDays: 21,
  maxSuggestions: 5,
  whatsappNumber: process.env.RIGBOT_DEFAULT_WSP || WHATSAPP_FALLBACK_PLACEHOLDER,
  pricingInfo: "Nuestros precios son competitivos. Por favor, consulta al contactarnos.",
  direccion: "Nuestra consulta está en Copiapó. Te daremos los detalles exactos al agendar.",
  horario: "Atendemos de Lunes a Viernes, de 10:00 a 19:30.",
  chiropracticVideoUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", // Placeholder
  telefono: "" // Teléfono general
};
// --- End Default Configuration ---

async function getClientConfig(clientId) {
  if (!clientId) {
    console.log("getClientConfig: No clientId provided, returning null.");
    return null;
  }
  if (!db) {
    console.error("getClientConfig: Firestore db no está inicializado.");
    return null;
  }
  try {
    const clientDocRef = doc(db, 'clients', clientId);
    const clientDocSnap = await getDoc(clientDocRef);
    if (clientDocSnap.exists()) {
      console.log(`getClientConfig: Configuración encontrada para clientId: ${clientId}`);
      return clientDocSnap.data();
    } else {
      console.log(`getClientConfig: No se encontró configuración para clientId: ${clientId}. Usando defaults.`);
      return null;
    }
  } catch (err) {
    console.error(`Error al obtener configuración para clientId ${clientId} desde Firestore:`, err);
    return null;
  }
}

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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Client-ID');

  const { message, sessionId: providedSessionId, clientId: bodyClientId } = req.body || {};
  const requestClientId = bodyClientId || req.headers['x-client-id'] || "demo-client";
  console.log(`INFO: Request entrante con effective clientId: ${requestClientId}`);

  const ipAddress = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null;
  const currentSessionId = providedSessionId || `session_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

  const clientConfigData = await getClientConfig(requestClientId);
  let effectiveConfig = { ...defaultConfig };

  if (clientConfigData) {
    console.log("INFO: Datos crudos desde Firestore:", clientConfigData);
    effectiveConfig.basePrompt = clientConfigData.basePrompt || defaultConfig.basePrompt;
    effectiveConfig.whatsappNumber = clientConfigData.whatsappNumber || defaultConfig.whatsappNumber;
    effectiveConfig.pricingInfo = clientConfigData.pricingInfo || defaultConfig.pricingInfo;
    effectiveConfig.direccion = clientConfigData.direccion || defaultConfig.direccion;
    effectiveConfig.horario = clientConfigData.horario || defaultConfig.horario;
    effectiveConfig.chiropracticVideoUrl = clientConfigData.chiropracticVideoUrl || defaultConfig.chiropracticVideoUrl;
    effectiveConfig.telefono = clientConfigData.telefono || defaultConfig.telefono;

    const firestoreCalendarQueryDays = Number(clientConfigData.calendarQueryDays);
    if (!isNaN(firestoreCalendarQueryDays) && firestoreCalendarQueryDays > 0) {
        effectiveConfig.calendarQueryDays = firestoreCalendarQueryDays;
    } else if (clientConfigData.calendarQueryDays !== undefined) { // Si existe pero no es válido
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
  } else {
    console.log(`INFO: No se encontraron datos en Firestore para ${requestClientId}, usando configuración por defecto completa.`);
  }

  // RIGO'S SUGGESTION: Log the effective configuration being used
  console.log("🧠 Configuración efectiva usada para clientId", requestClientId, ":", effectiveConfig);

  const getWhatsappContactMessage = (contactNumber) => {
    if (contactNumber && contactNumber !== WHATSAPP_FALLBACK_PLACEHOLDER && contactNumber.trim() !== "") {
      return ` Para más detalles o para agendar, conversemos por WhatsApp 👉 ${contactNumber}`;
    }
    return " Para más detalles o para agendar, por favor contáctanos a través de nuestros canales principales.";
  };
  const getWhatsappDerivationSuffix = (contactNumber) => {
    if (contactNumber && contactNumber !== WHATSAPP_FALLBACK_PLACEHOLDER && contactNumber.trim() !== "") {
      return ` ¡Escríbenos por WhatsApp al 👉 ${contactNumber}!`;
    }
    return " ¡Contáctanos para coordinar!";
  };

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    const errorResponsePayload = { error: 'Método no permitido' };
    if (typeof logRigbotMessage === "function") { /* Log */ }
    return res.status(405).json(errorResponsePayload);
  }

  if (!message) {
    const errorResponsePayload = { error: 'Falta el mensaje del usuario' };
    if (typeof logRigbotMessage === "function") { /* Log */ }
    return res.status(400).json(errorResponsePayload);
  }

  if (typeof logRigbotMessage === "function") { /* Log user message */ }

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
      console.log('⏳ Detectada consulta de calendario');
      let calendar;
      try {
        calendar = await getCalendarClient();
        if (!calendar || typeof calendar.events?.list !== 'function') {
          throw new Error("Cliente de calendario no inicializado correctamente.");
        }
      } catch (clientError) {
        console.error("❌ Error al obtener el cliente de Google Calendar:", clientError);
        const errorResponsePayload = { error: 'No se pudo conectar con el servicio de calendario.', details: clientError.message };
        if (typeof logRigbotMessage === "function") { /* Log */ }
        return res.status(500).json(errorResponsePayload);
      }
      
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
      const todayChile0000UtcTimestamp = Date.UTC(currentYearChile, currentMonthChile, currentDayOfMonthChile, 0 - CHILE_UTC_OFFSET_HOURS, 0, 0, 0);
      const refDateForTargetCalc = new Date(todayChile0000UtcTimestamp);
      const actualCurrentDayOfWeekInChile = refDateForTargetCalc.getUTCDay();
            
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
           } else if (daysToAdd === 0 && !isProximoWordQuery && serverNowUtc.getUTCHours() >= (19 - CHILE_UTC_OFFSET_HOURS)) { // Considerar el horario de cierre del día actual
             daysToAdd += 7;
           }
           targetDateForDisplay.setUTCDate(targetDateForDisplay.getUTCDate() + daysToAdd);
      } else if (isAnyNextWeekIndicator) {
           targetDateForDisplay = new Date(refDateForTargetCalc);
           let daysUntilNextMonday = (1 - actualCurrentDayOfWeekInChile + 7) % 7;
           if (daysUntilNextMonday === 0 && !isProximoWordQuery) daysUntilNextMonday = 7; // Si es hoy y no dice "próximo lunes", buscar el lunes de la otra semana
           targetDateForDisplay.setUTCDate(targetDateForDisplay.getUTCDate() + daysUntilNextMonday);
           isGenericNextWeekSearch = true;
      }
          
      if (targetDateForDisplay) {
        console.log(`🎯 Fecha Objetivo: ${new Intl.DateTimeFormat('es-CL', { dateStyle: 'full', timeZone: 'America/Santiago' }).format(targetDateForDisplay)} (UTC: ${targetDateForDisplay.toISOString()})`);
        const futureLimitCheckDate = new Date(refDateForTargetCalc);
        futureLimitCheckDate.setUTCDate(futureLimitCheckDate.getUTCDate() + effectiveConfig.calendarMaxUserRequestDays);
        if (targetDateForDisplay >= futureLimitCheckDate) {
          const formattedDateAsked = new Intl.DateTimeFormat('es-CL', { dateStyle: 'long', timeZone: 'America/Santiago' }).format(targetDateForDisplay);
          let reply = `¡Entiendo que buscas para el ${formattedDateAsked}! 😊 Por ahora, mi calendario mental solo llega hasta unos ${effectiveConfig.calendarMaxUserRequestDays} días en el futuro.${getWhatsappContactMessage(effectiveConfig.whatsappNumber)} y mis colegas humanos te ayudarán con gusto.`;
          if (typeof logRigbotMessage === "function") { await logRigbotMessage({ role: "assistant", content: reply, sessionId: currentSessionId, ip: ipAddress }); }
          return res.status(200).json({ response: reply });
        }
      }
          
      targetDateIdentifierForSlotFilter = (targetDateForDisplay && !isGenericNextWeekSearch) ? getDayIdentifier(targetDateForDisplay, 'America/Santiago') : null;
      
      const timeMatch = lowerMessage.match(/(\d{1,2})\s*(:(00|30|15|45))?\s*(pm|am|h|hr|hrs)?/i);
      if (timeMatch) {
        let hour = parseInt(timeMatch[1], 10);
        targetMinuteChile = timeMatch[3] ? parseInt(timeMatch[3], 10) : 0; // 00, 15, 30, 45
        const isPm = timeMatch[4] && timeMatch[4].toLowerCase() === 'pm';
        const isAm = timeMatch[4] && timeMatch[4].toLowerCase() === 'am';

        if (isPm && hour >= 1 && hour <= 11) hour += 12;
        if (isAm && hour === 12) hour = 0; // 12 AM es 00 horas

        targetHourChile = hour;
        // Ajustar minutos a :00 o :30 si son cercanos, o mantener si son exactos (00,15,30,45)
        if (targetMinuteChile > 0 && targetMinuteChile < 15) targetMinuteChile = 0;
        else if (targetMinuteChile > 15 && targetMinuteChile < 30) targetMinuteChile = 15; // o 30 si prefieres solo :00 y :30
        else if (targetMinuteChile > 30 && targetMinuteChile < 45) targetMinuteChile = 30;
        else if (targetMinuteChile > 45 && targetMinuteChile < 60) targetMinuteChile = 45; // o 00 de la sig hora si prefieres solo :00 y :30
        
        console.log(`⏰ Hora objetivo (Chile): ${targetHourChile}:${targetMinuteChile.toString().padStart(2,'0')}`);
      }

      if (!targetHourChile && !isAnyNextWeekIndicator && !isProximoWordQuery && !(targetDateForDisplay && getDayIdentifier(targetDateForDisplay, 'America/Santiago') !== getDayIdentifier(refDateForTargetCalc, 'America/Santiago'))) {
        if ((lowerMessage.includes('mañana') && !lowerMessage.includes('pasado mañana'))) {
            if (targetDateForDisplay && getDayIdentifier(targetDateForDisplay, 'America/Santiago') === getDayIdentifier(new Date(refDateForTargetCalc.getTime() + 24*60*60*1000), 'America/Santiago')) {
                timeOfDay = 'morning'; // Default para "mañana" si no se especifica más
            }
        } else if (lowerMessage.includes('tarde')) {
            timeOfDay = 'afternoon';
        }
         if(timeOfDay) console.log(`🕒 Franja horaria solicitada: ${timeOfDay}`);
      }
          
      const WORKING_HOURS_CHILE_NUMERIC = [10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5, 14, 14.5, 15, 15.5, 16, 16.5, 17, 17.5, 18, 18.5, 19, 19.5]; // Podría ser configurable desde effectiveConfig.horario
      if (targetHourChile !== null) {
        const requestedTimeNumeric = targetHourChile + (targetMinuteChile / 60);
        // Asumimos que effectiveConfig.horario es un string como "Lunes a Viernes de 10:00 a 19:30"
        // Para una validación precisa del horario, necesitaríamos parsear effectiveConfig.horario
        // Por ahora, usamos WORKING_HOURS_CHILE_NUMERIC como proxy.
        if (!WORKING_HOURS_CHILE_NUMERIC.includes(requestedTimeNumeric) || requestedTimeNumeric < 10 || requestedTimeNumeric > 19.5) {
          let replyPreamble = `¡Ojo! 👀 Parece que las ${targetHourChile.toString().padStart(2,'0')}:${targetMinuteChile.toString().padStart(2,'0')}`;
          if (targetDateForDisplay) {
            replyPreamble = `¡Ojo! 👀 Parece que el ${new Intl.DateTimeFormat('es-CL', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Santiago' }).format(targetDateForDisplay)} a las ${targetHourChile.toString().padStart(2,'0')}:${targetMinuteChile.toString().padStart(2,'0')}`;
          }
          let reply = `${replyPreamble} está fuera de nuestro horario de atención (${effectiveConfig.horario}). ¿Te gustaría buscar dentro de ese rango?${getWhatsappContactMessage(effectiveConfig.whatsappNumber)}`;
          if (typeof logRigbotMessage === "function") { await logRigbotMessage({ role: "assistant", content: reply, sessionId: currentSessionId, ip: ipAddress }); }
          return res.status(200).json({ response: reply });
        }
      }

      let calendarQueryStartUtc = targetDateForDisplay ? new Date(targetDateForDisplay.getTime()) : new Date(refDateForTargetCalc.getTime());
      const calendarQueryEndUtc = new Date(calendarQueryStartUtc);
      calendarQueryEndUtc.setUTCDate(calendarQueryStartUtc.getUTCDate() + effectiveConfig.calendarQueryDays);
      
      console.log(`🗓️ Google Calendar Query: De ${calendarQueryStartUtc.toISOString()} a ${calendarQueryEndUtc.toISOString()}`);
      let googleResponse;
      try {
        googleResponse = await calendar.events.list({
          calendarId: 'primary',
          timeMin: calendarQueryStartUtc.toISOString(),
          timeMax: calendarQueryEndUtc.toISOString(),
          singleEvents: true,
          orderBy: 'startTime'
        });
      } catch (googleError) {
        console.error("❌ ERROR DIRECTO en calendar.events.list:", googleError);
        const errorResponsePayload = { error: 'Error al consultar el calendario de Google.', details: googleError.message };
        if (typeof logRigbotMessage === "function") { /* Log */ }
        return res.status(500).json(errorResponsePayload);
      }
          
      const eventsFromGoogle = googleResponse?.data?.items || [];
      const busySlots = eventsFromGoogle.filter(e => e.status !== 'cancelled')
        .map(e => {
            if (e.start?.dateTime && e.end?.dateTime) {
              return { start: new Date(e.start.dateTime).getTime(), end: new Date(e.end.dateTime).getTime() };
            } else if (e.start?.date && e.end?.date) { // Eventos de todo el día
              const startDateAllDayUtc = new Date(e.start.date);
              const endDateAllDayUtc = new Date(e.end.date);
              return { start: startDateAllDayUtc.getTime(), end: endDateAllDayUtc.getTime() };
            }
            return null;
        }).filter(Boolean);
      console.log(`Found ${busySlots.length} busy slots from Google Calendar.`);

      const WORKING_HOURS_CHILE_STR = ['10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30', '14:00', '14:30', '15:00', '15:30', '16:00', '16:30', '17:00', '17:30', '18:00', '18:30', '19:00', '19:30'];
      const availableSlotsOutput = [];
      const processedDaysForGenericQuery = new Set();
      let baseIterationDateDayUtcStart = targetDateForDisplay ? new Date(targetDateForDisplay) : new Date(refDateForTargetCalc);

      for (let i = 0; i < effectiveConfig.calendarQueryDays; i++) {
        const currentDayProcessingUtcStart = new Date(baseIterationDateDayUtcStart);
        currentDayProcessingUtcStart.setUTCDate(baseIterationDateDayUtcStart.getUTCDate() + i);
        for (const timeChileStr of WORKING_HOURS_CHILE_STR) {
            const [hChile, mChile] = timeChileStr.split(':').map(Number);
            if (targetHourChile !== null) { // Si el usuario pidió hora específica
              if (hChile !== targetHourChile || mChile !== targetMinuteChile) { continue; }
            } else if (timeOfDay && !isGenericNextWeekSearch && !(isAnyNextWeekIndicator && !targetDateIdentifierForSlotFilter && !isProximoWordQuery) ) { // Si pidió franja horaria (mañana/tarde) para un día específico
              if (timeOfDay === 'morning' && (hChile < 10 || hChile >= 14)) continue; // Mañana es de 10:00 a 13:30
              if (timeOfDay === 'afternoon' && (hChile < 14 || hChile > 19 || (hChile === 19 && mChile > 30))) continue; // Tarde de 14:00 a 19:30
            }

            const slotStartUtc = convertChileTimeToUtc(currentDayProcessingUtcStart, hChile, mChile);
            if (isNaN(slotStartUtc.getTime())) { console.warn("SlotStartUtc inválido:", currentDayProcessingUtcStart, hChile, mChile); continue; }
            
            const slightlyFutureServerNowUtc = new Date(serverNowUtc.getTime() + 1 * 60 * 1000); // 1 minuto en el futuro para evitar slots que acaban de pasar
            if (slotStartUtc < slightlyFutureServerNowUtc) { continue; } // Slot ya pasó

            const slotDayIdentifierInChile = getDayIdentifier(slotStartUtc, 'America/Santiago');
            if (targetDateIdentifierForSlotFilter) { // Si se busca un día específico (hoy, mañana, lunes, etc.)
              if (slotDayIdentifierInChile !== targetDateIdentifierForSlotFilter) { continue; } // Solo mostrar slots de ese día
            }
            
            const slotEndUtc = new Date(slotStartUtc);
            slotEndUtc.setUTCMinutes(slotEndUtc.getUTCMinutes() + 30); // Duración de slots de 30 min
            
            const isBusy = busySlots.some(busy => slotStartUtc.getTime() < busy.end && slotEndUtc.getTime() > busy.start);
            
            if (!isBusy) {
              const formattedSlot = new Intl.DateTimeFormat('es-CL', {weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'America/Santiago'}).format(slotStartUtc);
              if (!targetDateIdentifierForSlotFilter && !targetHourChile) { // Búsqueda genérica (sin día ni hora específicos)
                  if (availableSlotsOutput.length < 10) { // Limitar un poco la búsqueda genérica inicial
                    if (!processedDaysForGenericQuery.has(slotDayIdentifierInChile) || availableSlotsOutput.length < 2) {
                        availableSlotsOutput.push(formattedSlot); processedDaysForGenericQuery.add(slotDayIdentifierInChile);
                    } else if (Array.from(processedDaysForGenericQuery).length < 3 && availableSlotsOutput.filter(s => s.startsWith(new Intl.DateTimeFormat('es-CL', {weekday: 'long', timeZone: 'America/Santiago'}).format(slotStartUtc))).length < 2) {
                        availableSlotsOutput.push(formattedSlot);
                    }
                  }
              } else { // Búsqueda para un día específico o una hora específica
                availableSlotsOutput.push(formattedSlot);
              }
            }
        }
        // Si ya filtramos por día y tenemos suficientes o es una hora específica, salimos
        if (targetDateIdentifierForSlotFilter && getDayIdentifier(currentDayProcessingUtcStart, 'America/Santiago') === targetDateIdentifierForSlotFilter) {
            if (targetHourChile !== null || availableSlotsOutput.length >= effectiveConfig.maxSuggestions ) break;
        }
        // Si es búsqueda genérica y ya tenemos suficientes sugerencias de varios días, salimos
        if (availableSlotsOutput.length >= effectiveConfig.maxSuggestions && !targetDateIdentifierForSlotFilter && !targetHourChile && processedDaysForGenericQuery.size >=2) break;
      }
          
      let replyCalendar = '';
      if (targetHourChile !== null) { // Usuario preguntó por una hora específica
        if (availableSlotsOutput.length > 0) {
          replyCalendar = `¡Excelente! 🎉 Justo el ${availableSlotsOutput[0]} está libre para ti. ¡Qué buena suerte! Para asegurar tu cita,${getWhatsappDerivationSuffix(effectiveConfig.whatsappNumber)} 😉`;
        } else {
          let specificTimeQuery = "";
          if(targetDateForDisplay) specificTimeQuery += `${new Intl.DateTimeFormat('es-CL', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Santiago' }).format(targetDateForDisplay)} `;
          specificTimeQuery += `a las ${targetHourChile.toString().padStart(2,'0')}:${targetMinuteChile.toString().padStart(2,'0')}`;
          replyCalendar = `¡Uy! Justo ${specificTimeQuery} no me quedan espacios. 😕 ¿Te gustaría que revise otro horario o quizás otro día?${getWhatsappContactMessage(effectiveConfig.whatsappNumber)}`;
        }
      } else if (availableSlotsOutput.length > 0) { // Búsqueda más general, se encontraron slots
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
        if (!targetDateIdentifierForSlotFilter && !targetHourChile) { // Lógica para agrupar/limitar en búsqueda genérica
            const slotsByDay = {};
            for (const slot of availableSlotsOutput) {
                const dayPart = slot.split(',')[0] + ', ' + slot.split(',')[1]; // Ej: "lunes, 20 de mayo"
                if (!slotsByDay[dayPart]) slotsByDay[dayPart] = [];
                if (slotsByDay[dayPart].length < 2) { // Max 2 sugerencias por día en la muestra inicial genérica
                    slotsByDay[dayPart].push(slot);
                }
            }
            let count = 0;
            for (const day in slotsByDay) {
                if (count >= effectiveConfig.maxSuggestions) break;
                for(const slot of slotsByDay[day]){
                    if (count >= effectiveConfig.maxSuggestions) break;
                    finalSuggestions.push(slot);
                    count++;
                }
            }
        } else { // Búsqueda para un día específico, tomar hasta maxSuggestions
            finalSuggestions = availableSlotsOutput.slice(0, effectiveConfig.maxSuggestions); 
        }

        replyCalendar = `${intro}\n- ${finalSuggestions.join('\n- ')}`;
        if (availableSlotsOutput.length > finalSuggestions.length && finalSuggestions.length > 0) {
          const remaining = availableSlotsOutput.length - finalSuggestions.length;
          if (remaining > 0) { replyCalendar += `\n\n(Y ${remaining} más... ¡para que tengas de dónde elegir! 😉)`; }
        }
        replyCalendar += `\n\nPara reservar alguna o si buscas otra opción,${getWhatsappDerivationSuffix(effectiveConfig.whatsappNumber)}`;
      } else { // No se encontraron slots para la búsqueda general
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

      console.log('✅ Respuesta generada (Calendario):', replyCalendar);
      if (typeof logRigbotMessage === "function") { await logRigbotMessage({ role: "assistant", content: replyCalendar, sessionId: currentSessionId, ip: ipAddress }); }
      return res.status(200).json({ response: replyCalendar });
    }

    // --- Rama de OpenAI ---
    console.log('💡 Consulta normal, usando OpenAI');
    
    let finalSystemPrompt = effectiveConfig.basePrompt;
    finalSystemPrompt = finalSystemPrompt.replace(/\$\{DAYS_TO_QUERY_CALENDAR\}/g, effectiveConfig.calendarQueryDays.toString());
    finalSystemPrompt = finalSystemPrompt.replace(/\$\{MAX_DAYS_FOR_USER_REQUEST\}/g, effectiveConfig.calendarMaxUserRequestDays.toString());
    if (effectiveConfig.whatsappNumber && effectiveConfig.whatsappNumber !== WHATSAPP_FALLBACK_PLACEHOLDER && effectiveConfig.whatsappNumber.trim() !== "") {
        finalSystemPrompt = finalSystemPrompt.replace(/\$\{whatsappNumber\}/g, effectiveConfig.whatsappNumber);
    } else {
        finalSystemPrompt = finalSystemPrompt.replace(/\$\{whatsappNumber\}/g, "nuestro principal canal de contacto telefónico o digital"); // Frase más genérica aún
    }
    finalSystemPrompt = finalSystemPrompt.replace(/\$\{pricingInfo\}/g, effectiveConfig.pricingInfo);
    finalSystemPrompt = finalSystemPrompt.replace(/\$\{direccion\}/g, effectiveConfig.direccion);
    finalSystemPrompt = finalSystemPrompt.replace(/\$\{horario\}/g, effectiveConfig.horario);
    finalSystemPrompt = finalSystemPrompt.replace(/\$\{chiropracticVideoUrl\}/g, effectiveConfig.chiropracticVideoUrl);

    console.log("System Prompt para OpenAI:", finalSystemPrompt.substring(0, 500) + "..."); // Loguear solo una parte para no llenar la consola

    const chatResponse = await openai.chat.completions.create({
      model: MODEL_FALLBACK, // Considerar hacerlo configurable: effectiveConfig.openaiModel
      messages: [
        { role: 'system', content: finalSystemPrompt },
        { role: 'user', content: message }
      ]
    });

    let gptReply = chatResponse.choices[0].message.content.trim();
    
    console.log('✅ Respuesta generada (OpenAI):', gptReply);
    if (typeof logRigbotMessage === "function") { await logRigbotMessage({ role: "assistant", content: gptReply, sessionId: currentSessionId, ip: ipAddress }); }
    return res.status(200).json({ response: gptReply });

  } catch (error) {
    console.error('❌ Error en Rigbot:', error);
    console.error(error.stack); // Stack trace completo para depuración
    const errorForUser = 'Ocurrió un error inesperado en Rigbot. Por favor, intenta más tarde o contacta a soporte si el problema persiste.';
    if (typeof logRigbotMessage === "function") { await logRigbotMessage({ role: "assistant", content: `Error interno: ${error.message}. UserMsg: ${errorForUser}`, sessionId: currentSessionId, ip: ipAddress }); }
    return res.status(500).json({ error: errorForUser, details: process.env.NODE_ENV === 'development' ? error.message + (error.stack ? `\nStack: ${error.stack.substring(0,300)}...` : '') : undefined });
  }
}