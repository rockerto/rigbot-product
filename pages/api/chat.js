// pages/api/chat.js

import { getCalendarClient } from '@/lib/google';
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o';
const CHILE_UTC_OFFSET_HOURS = -4; 
const MAX_SUGGESTIONS = 5; 
const DAYS_TO_QUERY_CALENDAR = 7; 
const MAX_DAYS_FOR_USER_REQUEST = 21;

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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'Falta el mensaje del usuario' });

  try {
    console.log('📨 Mensaje recibido:', message);
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
        console.log("DEBUG: Intentando obtener cliente de Google Calendar...");
        calendar = await getCalendarClient();
        if (!calendar || typeof calendar.events?.list !== 'function') {
            console.error("DEBUG ERROR: getCalendarClient() no devolvió un cliente de calendario válido.");
            throw new Error("Cliente de calendario no inicializado correctamente.");
        }
        console.log("DEBUG: Cliente de Google Calendar obtenido.");
      } catch (clientError) {
        console.error("❌ Error al obtener el cliente de Google Calendar:", clientError);
        return res.status(500).json({ error: 'No se pudo conectar con el servicio de calendario.', details: clientError.message });
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
        if (daysToAdd < 0) { 
          daysToAdd += 7; 
        }
        if ((isAnyNextWeekIndicator && daysToAdd < 7) || (daysToAdd === 0 && isProximoWordQuery)) {
          // Si es hoy y se pide "próximo X", o si se pide "X de la próxima semana" y el día X aún caería en esta semana
          // Aseguramos que daysToAdd sea al menos 7 para saltar a la semana siguiente.
          // Si daysToAdd ya es >= 7 (porque el día ya pasó y se sumó 7), no necesitamos sumar de nuevo si se dice "próxima semana".
          if (!(daysToAdd >=7 && isAnyNextWeekIndicator)) {
             daysToAdd += 7;
          }
        } else if (daysToAdd === 0 && !isProximoWordQuery && serverNowUtc.getUTCHours() >= (19 - CHILE_UTC_OFFSET_HOURS)) {
          daysToAdd += 7;
        }
        targetDateForDisplay.setUTCDate(targetDateForDisplay.getUTCDate() + daysToAdd);
      } else if (isAnyNextWeekIndicator) { 
          targetDateForDisplay = new Date(refDateForTargetCalc);
          let daysUntilNextMonday = (1 - actualCurrentDayOfWeekInChile + 7) % 7;
          if (daysUntilNextMonday === 0) daysUntilNextMonday = 7; 
          targetDateForDisplay.setUTCDate(targetDateForDisplay.getUTCDate() + daysUntilNextMonday); 
          isGenericNextWeekSearch = true; 
      }
      
      if (targetDateForDisplay) {
        console.log(`🎯 Fecha Objetivo (para mostrar y filtrar): ${new Intl.DateTimeFormat('es-CL', { dateStyle: 'full', timeZone: 'America/Santiago' }).format(targetDateForDisplay)} (UTC: ${targetDateForDisplay.toISOString()})`);
        const futureLimitCheckDate = new Date(refDateForTargetCalc); 
        futureLimitCheckDate.setUTCDate(futureLimitCheckDate.getUTCDate() + MAX_DAYS_FOR_USER_REQUEST);
        if (targetDateForDisplay >= futureLimitCheckDate) {
            const formattedDateAsked = new Intl.DateTimeFormat('es-CL', { dateStyle: 'long', timeZone: 'America/Santiago' }).format(targetDateForDisplay);
            let reply = `¡Entiendo que buscas para el ${formattedDateAsked}! 😊 Por ahora, mi calendario mental solo llega hasta unos ${MAX_DAYS_FOR_USER_REQUEST} días en el futuro. Para consultas más allá, por favor escribe directamente al WhatsApp 👉 +56 9 8996 7350 y mis colegas humanos te ayudarán con gusto.`;
            console.log('✅ Respuesta generada (fecha demasiado lejana):', reply);
            return res.status(200).json({ response: reply }); 
        }
      }
      
      targetDateIdentifierForSlotFilter = (targetDateForDisplay && !isGenericNextWeekSearch) ? getDayIdentifier(targetDateForDisplay, 'America/Santiago') : null;
      if(targetDateIdentifierForSlotFilter) { console.log(`🏷️ Identificador de Fecha para Filtro de Slots (Chile YAML-MM-DD): ${targetDateIdentifierForSlotFilter}`); } 
      else if (targetDateForDisplay && isGenericNextWeekSearch) { console.log(`🏷️ Búsqueda genérica para la semana que comienza el ${getDayIdentifier(targetDateForDisplay, 'America/Santiago')}, sin filtro de día específico.`); } 
      else { console.log(`🏷️ Búsqueda genérica desde hoy, sin filtro de día específico.`); }
      
      const timeMatch = lowerMessage.match(/(\d{1,2})\s*(:(00|30|15|45))?\s*(pm|am|h|hr|hrs)?/i);
      if (timeMatch) {
        let hour = parseInt(timeMatch[1], 10);
        targetMinuteChile = timeMatch[3] ? parseInt(timeMatch[3], 10) : 0; 
        const isPm = timeMatch[4] && timeMatch[4].toLowerCase() === 'pm';
        const isAm = timeMatch[4] && timeMatch[4].toLowerCase() === 'am';
        if (isPm && hour >= 1 && hour <= 11) hour += 12;
        if (isAm && hour === 12) hour = 0; 
        targetHourChile = hour;
        if (targetMinuteChile > 0 && targetMinuteChile < 30) targetMinuteChile = 0;
        else if (targetMinuteChile > 30 && targetMinuteChile < 60) targetMinuteChile = 30;
        console.log(`⏰ Hora objetivo (Chile): ${targetHourChile}:${targetMinuteChile.toString().padStart(2,'0')}`);
      }
      if (!targetHourChile && !isAnyNextWeekIndicator && !isProximoWordQuery && !(targetDateForDisplay && getDayIdentifier(targetDateForDisplay, 'America/Santiago') !== getDayIdentifier(refDateForTargetCalc, 'America/Santiago'))) { 
        if ((lowerMessage.includes('mañana') && !lowerMessage.includes('pasado mañana'))) {
             if (targetDateForDisplay && getDayIdentifier(targetDateForDisplay, 'America/Santiago') === getDayIdentifier(new Date(refDateForTargetCalc.getTime() + 24*60*60*1000), 'America/Santiago')) {
                timeOfDay = 'morning';
             }
        } else if (lowerMessage.includes('tarde')) {
            timeOfDay = 'afternoon';
        }
        if(timeOfDay) console.log(`🕒 Franja horaria: ${timeOfDay}`);
      }
      
      const WORKING_HOURS_CHILE_NUMERIC = [10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5, 14, 14.5, 15, 15.5, 16, 16.5, 17, 17.5, 18, 18.5, 19, 19.5];
      if (targetHourChile !== null) {
        const requestedTimeNumeric = targetHourChile + (targetMinuteChile / 60);
        if (!WORKING_HOURS_CHILE_NUMERIC.includes(requestedTimeNumeric) || requestedTimeNumeric < 10 || requestedTimeNumeric > 19.5) {
            let reply = `¡Ojo! 👀 Parece que las ${targetHourChile.toString().padStart(2,'0')}:${targetMinuteChile.toString().padStart(2,'0')}`;
            if (targetDateForDisplay) { 
                reply = `¡Ojo! 👀 Parece que el ${new Intl.DateTimeFormat('es-CL', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Santiago' }).format(targetDateForDisplay)} a las ${targetHourChile.toString().padStart(2,'0')}:${targetMinuteChile.toString().padStart(2,'0')}`;
            }
            reply += ` está fuera de nuestro horario de atención (10:00 a 19:30). ¿Te gustaría buscar dentro de ese rango? Si prefieres, para más ayuda, contáctanos por WhatsApp 👉 +56 9 8996 7350.`;
            console.log('✅ Respuesta generada (fuera de horario):', reply);
            return res.status(200).json({ response: reply });
        }
      }

      let calendarQueryStartUtc;
      if (targetDateForDisplay) { calendarQueryStartUtc = new Date(targetDateForDisplay.getTime());} 
      else { calendarQueryStartUtc = new Date(refDateForTargetCalc.getTime()); }
      const calendarQueryEndUtc = new Date(calendarQueryStartUtc);
      calendarQueryEndUtc.setUTCDate(calendarQueryStartUtc.getUTCDate() + DAYS_TO_QUERY_CALENDAR); 
      console.log(`🗓️ Google Calendar Query: De ${calendarQueryStartUtc.toISOString()} a ${calendarQueryEndUtc.toISOString()}`);

      let googleResponse;
      try {
        console.log("DEBUG: Intentando llamar a calendar.events.list...");
        googleResponse = await calendar.events.list({
          calendarId: 'primary', 
          timeMin: calendarQueryStartUtc.toISOString(),
          timeMax: calendarQueryEndUtc.toISOString(),
          singleEvents: true,
          orderBy: 'startTime'
        });
        console.log("DEBUG: Llamada a calendar.events.list completada.");
      } catch (googleError) {
        console.error("❌ ERROR DIRECTO en calendar.events.list:", googleError);
        return res.status(500).json({ error: 'Error al consultar el calendario de Google.', details: googleError.message });
      }
      
      const eventsFromGoogle = googleResponse && googleResponse.data && googleResponse.data.items ? googleResponse.data.items : [];
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
      console.log(`Found ${busySlots.length} busy slots from Google Calendar.`);
      if (busySlots.length > 0) {
        console.log("DEBUG: Contenido de busySlots (eventos UTC de Google Calendar):");
        busySlots.forEach((bs, index) => {
          const eventStartDate = new Date(bs.start);
          const eventEndDate = new Date(bs.end);
          if (eventEndDate > calendarQueryStartUtc && eventStartDate < calendarQueryEndUtc) { // Log solo eventos dentro del rango de la query
            console.log(`  BusySlot ${index}: Start: ${eventStartDate.toISOString()}, End: ${eventEndDate.toISOString()}`);
          }
        });
      }

      const WORKING_HOURS_CHILE_STR = [
        '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30',
        '14:00', '14:30', '15:00', '15:30', '16:00', '16:30', '17:00', '17:30',
        '18:00', '18:30', '19:00', '19:30'
      ];
      const availableSlotsOutput = [];
      const processedDaysForGenericQuery = new Set();       
      let baseIterationDateDayUtcStart;
      if (targetDateForDisplay) { baseIterationDateDayUtcStart = new Date(targetDateForDisplay); } 
      else { baseIterationDateDayUtcStart = new Date(refDateForTargetCalc); }

      console.log(`DEBUG: Iniciando bucle de ${DAYS_TO_QUERY_CALENDAR} días. Base UTC para iteración: ${baseIterationDateDayUtcStart.toISOString()}`);
      for (let i = 0; i < DAYS_TO_QUERY_CALENDAR; i++) {
        const currentDayProcessingUtcStart = new Date(baseIterationDateDayUtcStart);
        currentDayProcessingUtcStart.setUTCDate(baseIterationDateDayUtcStart.getUTCDate() + i);
        const currentDayProcessingIdentifierChile = getDayIdentifier(currentDayProcessingUtcStart, 'America/Santiago');
        console.log(`\nDEBUG: Bucle Día i=${i}. Iterando para día UTC: ${currentDayProcessingUtcStart.toISOString()} (Corresponde al día de Chile: ${currentDayProcessingIdentifierChile})`);
        if (targetDateIdentifierForSlotFilter) {
             console.log(`DEBUG: comparando con targetDateIdentifierForSlotFilter: ${targetDateIdentifierForSlotFilter}`);
        }

        for (const timeChileStr of WORKING_HOURS_CHILE_STR) {
          const [hChile, mChile] = timeChileStr.split(':').map(Number);
          let skipReason = ""; 
          if (targetHourChile !== null) { if (hChile !== targetHourChile || mChile !== targetMinuteChile) { skipReason = "Filtro de hora específica"; }
          } else if (timeOfDay && !isGenericNextWeekSearch && !(isAnyNextWeekIndicator && !targetDateIdentifierForSlotFilter && !isProximoWordQuery) ) { 
            if (timeOfDay === 'morning' && (hChile < 10 || hChile >= 14)) skipReason = "Filtro franja mañana";
            if (timeOfDay === 'afternoon' && (hChile < 14 || hChile > 19 || (hChile === 19 && mChile > 30))) skipReason = "Filtro franja tarde";
          }
          if (skipReason) { console.log(`  Slot ${timeChileStr} Chile DESCARTADO PREVIAMENTE por: ${skipReason}`); continue; }

          const slotStartUtc = convertChileTimeToUtc(currentDayProcessingUtcStart, hChile, mChile);
          const slotDayIdentifierInChile = getDayIdentifier(slotStartUtc, 'America/Santiago');
          console.log(`  SLOT CANDIDATO: ${timeChileStr} Chile. -> slotStartUtc: ${slotStartUtc.toISOString()} (Día en Chile del Slot: ${slotDayIdentifierInChile})`);

          if (isNaN(slotStartUtc.getTime())) { console.log(`    DESCARTADO: Slot UTC inválido.`); continue; }
          const slightlyFutureServerNowUtc = new Date(serverNowUtc.getTime() + 1 * 60 * 1000); 
          if (slotStartUtc < slightlyFutureServerNowUtc) { console.log(`    DESCARTADO: Slot es pasado (${slotStartUtc.toISOString()} < ${slightlyFutureServerNowUtc.toISOString()})`); continue; }

          if (targetDateIdentifierForSlotFilter) {
            if (slotDayIdentifierInChile !== targetDateIdentifierForSlotFilter) {
              console.log(`    DESCARTADO: Día del slot ${slotDayIdentifierInChile} NO es target ${targetDateIdentifierForSlotFilter}.`);
              continue; 
            }
            console.log(`    FILTRO DÍA: Día del slot ${slotDayIdentifierInChile} SÍ es target ${targetDateIdentifierForSlotFilter}.`);
          } else { console.log(`    FILTRO DÍA: No hay targetDateIdentifierForSlotFilter (búsqueda genérica para este slot).`); }

          const slotEndUtc = new Date(slotStartUtc);
          slotEndUtc.setUTCMinutes(slotEndUtc.getUTCMinutes() + 30);
          const isBusy = busySlots.some(busy => slotStartUtc.getTime() < busy.end && slotEndUtc.getTime() > busy.start);
          console.log(`    EVALUANDO: ${new Intl.DateTimeFormat('es-CL', {weekday: 'long', day: 'numeric', month: 'long',hour: '2-digit', minute: '2-digit', timeZone: 'America/Santiago'}).format(slotStartUtc)} - ¿Está ocupado? ${isBusy}`);
          
          if (!isBusy) { 
            const formattedSlot = new Intl.DateTimeFormat('es-CL', {weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'America/Santiago'}).format(slotStartUtc);
            if (!targetDateIdentifierForSlotFilter && !targetHourChile) { 
                if (availableSlotsOutput.length < 10) { 
                    if (!processedDaysForGenericQuery.has(slotDayIdentifierInChile) || availableSlotsOutput.length < 2) {
                         availableSlotsOutput.push(formattedSlot); processedDaysForGenericQuery.add(slotDayIdentifierInChile); console.log(`      ✅ AÑADIDO (genérico, nuevo día): ${formattedSlot}`);
                    } else if (Array.from(processedDaysForGenericQuery).length < 3 && availableSlotsOutput.filter(s => s.startsWith(new Intl.DateTimeFormat('es-CL', {weekday: 'long', timeZone: 'America/Santiago'}).format(slotStartUtc))).length < 2) {
                         availableSlotsOutput.push(formattedSlot); console.log(`      ✅ AÑADIDO (genérico, mismo día, <2): ${formattedSlot}`);
                    } else { console.log(`      DEBUG: NO AÑADIDO (genérico, límite de variedad)`);}
                } else { console.log(`      DEBUG: NO AÑADIDO (genérico, output.length >= 10)`);}
            } else { availableSlotsOutput.push(formattedSlot); console.log(`      ✅ AÑADIDO (específico): ${formattedSlot}`);}
          } else { console.log(`      OCUPADO (isBusy=true).`);}
        }
        if (targetDateIdentifierForSlotFilter && getDayIdentifier(currentDayProcessingUtcStart, 'America/Santiago') === targetDateIdentifierForSlotFilter) {
            if (targetHourChile !== null || availableSlotsOutput.length >= MAX_SUGGESTIONS ) break; 
        }
        if (availableSlotsOutput.length >= MAX_SUGGESTIONS && !targetDateIdentifierForSlotFilter && !targetHourChile && processedDaysForGenericQuery.size >=2) break; 
      }
      
      if(targetDateIdentifierForSlotFilter) { console.log(`🔎 Slots encontrados para el día de Chile ${targetDateIdentifierForSlotFilter}: ${availableSlotsOutput.length}`); } 
      else { console.log(`🔎 Slots encontrados en búsqueda genérica (próximos ${DAYS_TO_QUERY_CALENDAR} días): ${availableSlotsOutput.length}`); }
      
      let reply = '';
      if (targetHourChile !== null) { 
        if (availableSlotsOutput.length > 0) {
          reply = `¡Excelente! 🎉 Justo el ${availableSlotsOutput[0]} está libre para ti. ¡Qué buena suerte! Para asegurar tu cita, contáctanos directamente por WhatsApp al 👉 +56 9 8996 7350 y la reservamos. 😉`;
        } else {
          let specificTimeQuery = "";
          if(targetDateForDisplay) specificTimeQuery += `${new Intl.DateTimeFormat('es-CL', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Santiago' }).format(targetDateForDisplay)} `;
          specificTimeQuery += `a las ${targetHourChile.toString().padStart(2,'0')}:${targetMinuteChile.toString().padStart(2,'0')}`;
          reply = `¡Uy! Justo ${specificTimeQuery} no me quedan espacios. 😕 ¿Te gustaría que revise otro horario o quizás otro día? Si prefieres, puedes escribirnos a WhatsApp al 👉 +56 9 8996 7350.`;
        }
      } else if (availableSlotsOutput.length > 0) { 
        let intro = `¡Buenas noticias! 🎉 Encontré estas horitas disponibles`;
        if (targetDateForDisplay) {
            intro += ` para el ${new Intl.DateTimeFormat('es-CL', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Santiago' }).format(targetDateForDisplay)}`;
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
                const dayName = slot.split(',')[0]; 
                if (!slotsByDay[dayName]) slotsByDay[dayName] = [];
                if (slotsByDay[dayName].length < 2) { slotsByDay[dayName].push(slot); }
            }
            let count = 0;
            for (const day in slotsByDay) { 
                for(const slot of slotsByDay[day]){
                    if(count < MAX_SUGGESTIONS){ finalSuggestions.push(slot); count++; } else { break; }
                }
                if (count >= MAX_SUGGESTIONS) break; 
            }
        } else { finalSuggestions = availableSlotsOutput.slice(0, MAX_SUGGESTIONS); }
        reply = `${intro}\n- ${finalSuggestions.join('\n- ')}`;
        if (availableSlotsOutput.length > finalSuggestions.length && finalSuggestions.length > 0) { 
           const remaining = availableSlotsOutput.length - finalSuggestions.length;
           if (remaining > 0) { reply += `\n\n(Y ${remaining} más... ¡para que tengas de dónde elegir! 😉)`; }
        }
        // Siempre ofrecer WhatsApp cuando se listan horarios
        reply += `\n\nPara reservar alguna o si buscas otra opción, ¡conversemos por WhatsApp! 👉 +56 9 8996 7350.`;
      } else { 
        reply = '¡Pucha! 😔 Parece que no tengo horas libres';
        if (targetDateForDisplay) {
            reply += ` para el ${new Intl.DateTimeFormat('es-CL', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Santiago' }).format(targetDateForDisplay)}`;
        } else if (isAnyNextWeekIndicator) { reply += ` para la próxima semana`; }
        if (timeOfDay === 'morning') reply += ' por la mañana'; if (timeOfDay === 'afternoon') reply += ' por la tarde';
        if (targetHourChile !== null && !targetDateForDisplay && !isAnyNextWeekIndicator) reply += ` a las ${targetHourChile.toString().padStart(2,'0')}:${targetMinuteChile.toString().padStart(2,'0')}`
        if (targetDateForDisplay || timeOfDay || targetHourChile || isAnyNextWeekIndicator) { reply += '.'; } 
        else { reply += ` dentro de los próximos ${DAYS_TO_QUERY_CALENDAR} días.`; }
        reply += ' ¿Te animas a que busquemos en otra fecha u horario? Si no, para una atención más personalizada, escríbenos por WhatsApp al 👉 +56 9 8996 7350. ¡Seguro te podemos ayudar!';
      }
      
      console.log('✅ Respuesta generada:', reply);
      return res.status(200).json({ response: reply });
    } 

    console.log('💡 Consulta normal, usando OpenAI');
    const systemPrompt = process.env.RIGBOT_PROMPT || 
`Eres Rigbot, el asistente virtual de la consulta quiropráctica Rigquiropráctico, atendido por el quiropráctico Roberto Ibacache en Copiapó, Chile.
Tu rol es entregar información clara, profesional, cálida y empática a quienes consultan por servicios quiroprácticos. Cuando te pregunten por horarios, tu capacidad principal es revisar la disponibilidad.

CAPACIDADES DE HORARIOS:
- Puedo revisar la disponibilidad para los próximos ${DAYS_TO_QUERY_CALENDAR} días aproximadamente, comenzando desde la fecha que me indiques (o desde hoy si no especificas).
- Si el usuario pide un día o franja específica dentro de ese rango, me enfocaré en eso.
- Si pide una hora específica y está disponible, la confirmaré con entusiasmo.
- Si una hora específica NO está disponible, informaré y puedo sugerir alternativas cercanas para ESE MISMO DÍA si las hay. Si no, simplemente diré que no hay para esa hora/día.
- Si no encuentro horarios para tus criterios dentro de mi rango de búsqueda (los próximos ${DAYS_TO_QUERY_CALENDAR} días), te lo haré saber claramente.
- **IMPORTANTE:** Si el usuario pregunta por fechas más allá de los ${DAYS_TO_QUERY_CALENDAR} días que puedo ver claramente (ej. "en 3 semanas", "el proximo mes"), o si la búsqueda es muy compleja, o directamente para agendar, confirmar detalles y pagar, indícale amablemente que para esos casos es mejor que escriba directamente al WhatsApp. NO intentes adivinar o buscar para esas fechas lejanas tú mismo. Simplemente informa tu límite y deriva a WhatsApp.

DERIVACIÓN A WHATSAPP (Úsala cuando sea apropiado, especialmente al final de una consulta de horarios o si no puedes ayudar más con el calendario):
"Para más detalles, confirmar tu hora, consultar por fechas más lejanas, o cualquier otra pregunta, conversemos por WhatsApp 👉 +56 9 8996 7350 ¡Mis colegas humanos te esperan para ayudarte!" (Puedes variar la frase para que suene natural y alegre).

INFO GENERAL (Solo si se pregunta directamente):
PRECIOS: 1 sesión: $40.000, Pack 2: $70.000, Pack 3: $100.000, Pack 5: $160.000, Pack 10: $300.000. Packs compartibles con pago único.
DIRECCIÓN: Centro de Salud Fleming, Van Buren 129, Copiapó. (Solo entregar si ya se ha hablado de agendar o pagar, e invitar a WhatsApp para confirmar).
QUIROPRAXIA VIDEO: Si preguntan qué es, comparte https://youtu.be/EdEZyZUDAw0 (placeholder) y explica brevemente.

TONO:
¡Siempre alegre y optimista! Cálido, empático, servicial y profesional, pero muy cercano y amigable. Evita ser robótico. Adapta tu entusiasmo al del usuario. Usa emojis con moderación para realzar el tono. 🎉😊👍👀🥳`;

    const chatResponse = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message }
      ]
    });

    let gptReply = chatResponse.choices[0].message.content.trim();
    return res.status(200).json({ response: gptReply });

  } catch (error) {
    console.error('❌ Error en Rigbot:', error);
    console.error(error.stack); 
    return res.status(500).json({ error: 'Ocurrió un error en Rigbot. ' + error.message });
  }
}