// rigbot-product/pages/api/chat.js
import { getCalendarClient } from '@/lib/google'; // Asegúrate que esta ruta sea correcta
import OpenAI from 'openai';
import { logRigbotMessage } from "@/lib/rigbotLog"; // Asegúrate que esta ruta sea correcta
import { DEFAULT_SYSTEM_PROMPT_TEMPLATE } from '@/lib/defaultSystemPromptTemplate'; // Asegúrate que esta ruta sea correcta

// --- Firebase Admin Setup ---
import { getFirestore, doc, getDoc } from 'firebase-admin/firestore';
import { initializeApp as initializeAdminAppFirebase, getApps as getAdminAppsFirebase, cert } from 'firebase-admin/app'; // Renombré para evitar colisión si usaras firebase/app (cliente)

if (!getAdminAppsFirebase().length) {
  try {
    const serviceAccountString = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (!serviceAccountString || serviceAccountString.trim() === "") {
      throw new Error("La variable de entorno GOOGLE_APPLICATION_CREDENTIALS no está definida o está vacía.");
    }
    // Parseamos el string JSON a un objeto
    const serviceAccount = JSON.parse(serviceAccountString); 
    
    initializeAdminAppFirebase({ // Usar el nombre importado
      credential: cert(serviceAccount) // Usamos cert() para pasar el objeto parseado
    });
    console.log("Firebase Admin SDK inicializado con credenciales parseadas explícitamente.");
  } catch (e) {
    console.error("Error CRÍTICO inicializando Firebase Admin SDK:", e);
    if (e.message.includes("GOOGLE_APPLICATION_CREDENTIALS no está definida")) {
        console.error("CAUSA PROBABLE: La variable de entorno GOOGLE_APPLICATION_CREDENTIALS está vacía o no existe en Vercel para el proyecto rigbot-product.");
    } else if (e instanceof SyntaxError) { // Error al parsear el JSON
        console.error("CAUSA PROBABLE: El contenido de GOOGLE_APPLICATION_CREDENTIALS no es un JSON válido. Asegúrate de pegar el contenido COMPLETO y EXACTO del archivo JSON de tu clave de servicio. Verifica que no haya caracteres extraños o que esté incompleto. Primeros/últimos chars problemáticos:", process.env.GOOGLE_APPLICATION_CREDENTIALS?.substring(0,100), "...", process.env.GOOGLE_APPLICATION_CREDENTIALS?.slice(-100));
    } else {
        console.error("CAUSA PROBABLE: Otro error durante la inicialización del SDK Admin. Revisa el stack trace y el valor de GOOGLE_APPLICATION_CREDENTIALS en Vercel.");
    }
  }
}

let db;
try {
    db = getFirestore();
} catch (e) {
    console.error("Error obteniendo instancia de Firestore (getFirestore()) DESPUÉS de intento de inicialización:", e);
    // db seguirá undefined, se verificará más adelante antes de usar.
}
// --- End Firebase Admin Setup ---

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

async function getClientConfig(clientId) {
  if (!clientId) {
    console.log("getClientConfig: No clientId provided, returning null.");
    return null;
  }
  if (!db || typeof db.collection !== 'function') {
    console.error("getClientConfig: Firestore db no está inicializado o no es una instancia válida. Firebase Admin SDK pudo fallar al iniciar o GOOGLE_APPLICATION_CREDENTIALS es incorrecta.");
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
  // --- INICIO Manejo de CORS Mejorado ---
  const allowedOriginsString = process.env.ALLOWED_ORIGINS || "https://rigsite-web.vercel.app"; // Fallback a tu frontend principal
  const allowedOrigins = allowedOriginsString.split(',').map(origin => origin.trim());
  const requestOrigin = req.headers.origin;
  let corsOriginAllowed = false;

  if (requestOrigin) {
    if (allowedOrigins.includes(requestOrigin)) {
      res.setHeader('Access-Control-Allow-Origin', requestOrigin);
      corsOriginAllowed = true;
    } else if (process.env.NODE_ENV === 'development' && requestOrigin.startsWith('http://localhost:')) {
      res.setHeader('Access-Control-Allow-Origin', requestOrigin);
      corsOriginAllowed = true;
      console.log("INFO CORS: Origen localhost de desarrollo permitido:", requestOrigin);
    } else {
      console.warn("WARN CORS: Origen no permitido:", requestOrigin, "| Permitidos:", allowedOrigins.join(' '));
    }
  } else {
    console.log("INFO CORS: No se detectó header 'origin' en la solicitud.");
    // Para solicitudes same-origin o sin origin (como Postman a veces), no se necesita el header
    // Pero si esperas cross-origin y no viene, es raro.
  }
  
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Client-ID, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    console.log("INFO: Recibida solicitud OPTIONS para CORS preflight desde:", requestOrigin, "| CORS permitido para origin?:", corsOriginAllowed);
    // Si el origen no fue permitido arriba y es una solicitud OPTIONS, podría fallar aquí.
    // Para OPTIONS, es crucial que Access-Control-Allow-Origin se setee si el origin es válido.
    // Si finalAllowedOrigin no se seteó, la respuesta OPTIONS no tendrá el header y fallará el preflight.
    if (corsOriginAllowed) {
        return res.status(204).end(); 
    } else {
        // Si el origen no está en la lista y es una petición OPTIONS, es un preflight fallido.
        // Aún así, Vercel podría manejar esto antes de llegar aquí si el path no machea un allowed origin en config de Vercel.
        console.warn("WARN CORS: Solicitud OPTIONS de origen no permitido bloqueada:", requestOrigin);
        return res.status(403).json({ error: "Origen no permitido por CORS." }); // O simplemente 204, pero el navegador lo bloqueará igual si no hay header
    }
  }
  // --- FIN Manejo de CORS Mejorado ---

  const { message, sessionId: providedSessionId, clientId: bodyClientId } = req.body || {};
  const requestClientId = bodyClientId || req.headers['x-client-id'] || "demo-client";
  console.log(`INFO: Request entrante ${req.method} para /api/chat con effective clientId: ${requestClientId}`);

  const ipAddress = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null;
  const currentSessionId = providedSessionId || `session_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

  if (!db || typeof db.collection !== 'function') {
      console.error("FATAL: Firestore DB no está disponible. Revise inicialización de Firebase Admin SDK y GOOGLE_APPLICATION_CREDENTIALS en Vercel para rigbot-product.");
      const errorResponsePayload = { error: 'Error interno del servidor: No se pudo conectar a la base de datos de configuración.' };
      return res.status(500).json(errorResponsePayload);
  }

  const clientConfigData = await getClientConfig(requestClientId);
  let effectiveConfig = { ...defaultConfig };

  if (clientConfigData) {
    console.log("INFO: Datos crudos desde Firestore:", JSON.stringify(clientConfigData, null, 2));
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
  } else {
    console.log(`INFO: No se encontraron datos en Firestore para ${requestClientId}, usando configuración por defecto completa.`);
  }

  console.log("🧠 Configuración efectiva usada para clientId", requestClientId, ":", JSON.stringify(effectiveConfig, null, 2));

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

  // Ya manejamos OPTIONS arriba, esta verificación es para otros métodos.
  if (req.method !== 'POST') { 
    const errorResponsePayload = { error: 'Método no permitido' };
    if (typeof logRigbotMessage === "function") { await logRigbotMessage({ role: "assistant", content: `Error: ${errorResponsePayload.error}`, sessionId: currentSessionId, ip: ipAddress }); }
    return res.status(405).json(errorResponsePayload);
  }

  if (!message) {
    const errorResponsePayload = { error: 'Falta el mensaje del usuario' };
    if (typeof logRigbotMessage === "function") { await logRigbotMessage({ role: "assistant", content: `Error: ${errorResponsePayload.error}`, sessionId: currentSessionId, ip: ipAddress }); }
    return res.status(400).json(errorResponsePayload);
  }

  if (typeof logRigbotMessage === "function") { 
    try {
      await logRigbotMessage({ role: "user", content: message, sessionId: currentSessionId, ip: ipAddress });
    } catch (logErr) {
      console.error("Error al loguear mensaje de usuario en Firestore:", logErr);
    }
  }

  try {
    console.log(`📨 Mensaje ("${message}") recibido para ${requestClientId}`);
    const lowerMessage = message.toLowerCase();

    const calendarKeywords = [
      'hora', 'turno', 'disponibilidad', 'agenda', 'cuando', 'horario', 'disponible', 'libre', 'atiendes', 
      'ver', 'revisar', 'chequear', 'consultar', 'lunes', 'martes', 'miercoles', 'miércoles', 'jueves', 
      'viernes', 'sabado', 'sábado', 'domingo', 'hoy', 'mañana', 'tarde', 'a las', 'para el', 
      'tienes algo', 'hay espacio', 'agendar', 'agendamiento', 'proxima semana', 'próxima semana', 
      'prixima semana', 'procsima semana', 'proxima semama', 'proximo', 'próximo', 'priximo', 'procsimo'
    ];
    const isCalendarQuery = calendarKeywords.some(keyword => lowerMessage.includes(keyword));

    if (isCalendarQuery) {
      console.log('⏳ Detectada consulta de calendario para', requestClientId);
      let calendar;
      try {
        calendar = await getCalendarClient();
        if (!calendar || typeof calendar.events?.list !== 'function') {
          console.error("DEBUG ERROR: getCalendarClient() no devolvió un cliente de calendario válido para", requestClientId);
          throw new Error("Cliente de calendario no inicializado correctamente.");
        }
        console.log("DEBUG: Cliente de Google Calendar obtenido para", requestClientId);
      } catch (clientError) {
        console.error("❌ Error al obtener el cliente de Google Calendar para", requestClientId, ":", clientError);
        const errorResponsePayload = { error: 'No se pudo conectar con el servicio de calendario.', details: clientError.message };
        if (typeof logRigbotMessage === "function") { await logRigbotMessage({ role: "assistant", content: `Error interno: ${errorResponsePayload.error} Detalles: ${errorResponsePayload.details}`, sessionId: currentSessionId, ip: ipAddress });}
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
          if (typeof logRigbotMessage === "function") { await logRigbotMessage({ role: "assistant", content: reply, sessionId: currentSessionId, ip: ipAddress }); }
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
        const isPm = timeMatch[4] && timeMatch[4].toLowerCase() === 'pm';
        const isAm = timeMatch[4] && timeMatch[4].toLowerCase() === 'am';
        if (isPm && hour >= 1 && hour <= 11) hour += 12;
        if (isAm && hour === 12) hour = 0;
        targetHourChile = hour;
        if (targetMinuteChile > 0 && targetMinuteChile < 15) targetMinuteChile = 0;
        else if (targetMinuteChile > 15 && targetMinuteChile < 30) targetMinuteChile = 15;
        else if (targetMinuteChile > 30 && targetMinuteChile < 45) targetMinuteChile = 30;
        else if (targetMinuteChile > 45 && targetMinuteChile < 60) targetMinuteChile = 45;
        console.log(`⏰ Hora objetivo (Chile) para ${requestClientId}: ${targetHourChile}:${targetMinuteChile.toString().padStart(2,'0')}`);
      }

      if (!targetHourChile && !isAnyNextWeekIndicator && !isProximoWordQuery && !(targetDateForDisplay && getDayIdentifier(targetDateForDisplay, 'America/Santiago') !== getDayIdentifier(refDateForTargetCalc, 'America/Santiago'))) {
        if ((lowerMessage.includes('mañana') && !lowerMessage.includes('pasado mañana'))) {
            if (targetDateForDisplay && getDayIdentifier(targetDateForDisplay, 'America/Santiago') === getDayIdentifier(new Date(refDateForTargetCalc.getTime() + 24*60*60*1000), 'America/Santiago')) {
                timeOfDay = 'morning';
            }
        } else if (lowerMessage.includes('tarde')) {
            timeOfDay = 'afternoon';
        }
         if(timeOfDay) console.log(`🕒 Franja horaria solicitada para ${requestClientId}: ${timeOfDay}`);
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
          if (typeof logRigbotMessage === "function") { await logRigbotMessage({ role: "assistant", content: reply, sessionId: currentSessionId, ip: ipAddress }); }
          return res.status(200).json({ response: reply });
        }
      }

      let calendarQueryStartUtc = targetDateForDisplay ? new Date(targetDateForDisplay.getTime()) : new Date(refDateForTargetCalc.getTime());
      const calendarQueryEndUtc = new Date(calendarQueryStartUtc);
      calendarQueryEndUtc.setUTCDate(calendarQueryStartUtc.getUTCDate() + effectiveConfig.calendarQueryDays);
      
      console.log(`🗓️ Google Calendar Query para ${requestClientId}: De ${calendarQueryStartUtc.toISOString()} a ${calendarQueryEndUtc.toISOString()}`);
      let googleResponse;
      try {
        console.log("DEBUG: Intentando llamar a calendar.events.list para", requestClientId);
        googleResponse = await calendar.events.list({
          calendarId: 'primary',
          timeMin: calendarQueryStartUtc.toISOString(),
          timeMax: calendarQueryEndUtc.toISOString(),
          singleEvents: true,
          orderBy: 'startTime'
        });
        console.log("DEBUG: Llamada a calendar.events.list completada para", requestClientId);
      } catch (googleError) {
        console.error(`❌ ERROR DIRECTO en calendar.events.list para ${requestClientId}:`, googleError);
        const errorResponsePayload = { error: 'Error al consultar el calendario de Google.', details: googleError.message };
        if (typeof logRigbotMessage === "function") { await logRigbotMessage({ role: "assistant", content: `Error interno: ${errorResponsePayload.error} Detalles: ${errorResponsePayload.details}`, sessionId: currentSessionId, ip: ipAddress });}
        return res.status(500).json(errorResponsePayload);
      }
          
      const eventsFromGoogle = googleResponse?.data?.items || [];
      const busySlots = eventsFromGoogle.filter(e => e.status !== 'cancelled')
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
      console.log(`Found ${busySlots.length} busy slots from Google Calendar for ${requestClientId}.`);
      if (busySlots.length > 0) {
          console.log(`DEBUG: Contenido de busySlots (eventos UTC de Google Calendar) para ${requestClientId}:`);
          busySlots.forEach((bs, index) => {
            const eventStartDate = new Date(bs.start);
            const eventEndDate = new Date(bs.end);
            if (eventEndDate > calendarQueryStartUtc && eventStartDate < calendarQueryEndUtc) {
              console.log(`  BusySlot ${index}: Start: ${eventStartDate.toISOString()}, End: ${eventEndDate.toISOString()}`);
            }
          });
      }

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
            if (targetHourChile !== null) {
              if (hChile !== targetHourChile || mChile !== targetMinuteChile) { continue; }
            } else if (timeOfDay && !isGenericNextWeekSearch && !(isAnyNextWeekIndicator && !targetDateIdentifierForSlotFilter && !isProximoWordQuery) ) {
              if (timeOfDay === 'morning' && (hChile < 10 || hChile >= 14)) continue;
              if (timeOfDay === 'afternoon' && (hChile < 14 || hChile > 19 || (hChile === 19 && mChile > 30))) continue;
            }
            const slotStartUtc = convertChileTimeToUtc(currentDayProcessingUtcStart, hChile, mChile);
            if (isNaN(slotStartUtc.getTime())) { console.warn("SlotStartUtc inválido:", currentDayProcessingUtcStart, hChile, mChile); continue; }
            const slightlyFutureServerNowUtc = new Date(serverNowUtc.getTime() + 1 * 60 * 1000);
            if (slotStartUtc < slightlyFutureServerNowUtc) { continue; }
            const slotDayIdentifierInChile = getDayIdentifier(slotStartUtc, 'America/Santiago');
            if (targetDateIdentifierForSlotFilter) {
              if (slotDayIdentifierInChile !== targetDateIdentifierForSlotFilter) { continue; }
            }
            const slotEndUtc = new Date(slotStartUtc);
            slotEndUtc.setUTCMinutes(slotEndUtc.getUTCMinutes() + 30);
            const isBusy = busySlots.some(busy => slotStartUtc.getTime() < busy.end && slotEndUtc.getTime() > busy.start);
            if (!isBusy) {
              const formattedSlot = new Intl.DateTimeFormat('es-CL', {weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'America/Santiago'}).format(slotStartUtc);
              if (!targetDateIdentifierForSlotFilter && !targetHourChile) {
                  if (availableSlotsOutput.length < 10) {
                    if (!processedDaysForGenericQuery.has(slotDayIdentifierInChile) || availableSlotsOutput.length < 2) {
                        availableSlotsOutput.push(formattedSlot); processedDaysForGenericQuery.add(slotDayIdentifierInChile);
                    } else if (Array.from(processedDaysForGenericQuery).length < 3 && availableSlotsOutput.filter(s => s.startsWith(new Intl.DateTimeFormat('es-CL', {weekday: 'long', timeZone: 'America/Santiago'}).format(slotStartUtc))).length < 2) {
                        availableSlotsOutput.push(formattedSlot);
                    }
                  }
              } else {
                availableSlotsOutput.push(formattedSlot);
              }
            }
        }
        if (targetDateIdentifierForSlotFilter && getDayIdentifier(currentDayProcessingUtcStart, 'America/Santiago') === targetDateIdentifierForSlotFilter) {
            if (targetHourChile !== null || availableSlotsOutput.length >= effectiveConfig.maxSuggestions ) break;
        }
        if (availableSlotsOutput.length >= effectiveConfig.maxSuggestions && !targetDateIdentifierForSlotFilter && !targetHourChile && processedDaysForGenericQuery.size >=2) break;
      }
          
      if(targetDateIdentifierForSlotFilter) { console.log(`🔎 Slots encontrados para el día de Chile ${targetDateIdentifierForSlotFilter} para ${requestClientId}: ${availableSlotsOutput.length}`); }
      else { console.log(`🔎 Slots encontrados en búsqueda genérica (próximos ${effectiveConfig.calendarQueryDays} días) para ${requestClientId}: ${availableSlotsOutput.length}`); }
          
      let replyCalendar = '';
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
            for (const day in slotsByDay) {
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

      console.log('✅ Respuesta generada (Calendario):', replyCalendar);
      if (typeof logRigbotMessage === "function") { await logRigbotMessage({ role: "assistant", content: replyCalendar, sessionId: currentSessionId, ip: ipAddress }); }
      return res.status(200).json({ response: replyCalendar });
    }

    // --- Rama de OpenAI ---
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
      model: MODEL_FALLBACK, // Podrías hacerlo configurable: effectiveConfig.openaiModel
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
    console.error(`❌ Error en Rigbot para clientId ${requestClientId}:`, error);
    console.error(error.stack);
    const errorForUser = 'Ocurrió un error inesperado en Rigbot. Por favor, intenta más tarde o contacta a soporte si el problema persiste.';
    if (typeof logRigbotMessage === "function") { await logRigbotMessage({ role: "assistant", content: `Error interno: ${error.message}. UserMsg: ${errorForUser}`, sessionId: currentSessionId, ip: ipAddress }); }
    return res.status(500).json({ error: errorForUser, details: process.env.NODE_ENV === 'development' ? error.message + (error.stack ? `\nStack: ${error.stack.substring(0,300)}...` : '') : undefined });
  }
}