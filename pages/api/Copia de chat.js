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

    // ***** CALENDAR KEYWORDS ACTUALIZADAS *****
    const calendarKeywords = [
      'hora', 'turno', 'disponibilidad', 'agenda', 'cuando', 'horario', 
      'disponible', 'libre', 'atiendes', 'ver', 'revisar', 'chequear', 'consultar',
      'lunes', 'martes', 'miercoles', 'miércoles', 'jueves', 'viernes', 'sabado', 'sábado', 'domingo',
      'hoy', 'mañana', 
      'tarde', 
      'a las', 
      'para el', 
      'tienes algo', 
      'hay espacio', 
      'agendar', 'agendamiento',
      'proxima semana', 'próxima semana', 'prixima semana', 'procsima semana', 'proxima semama', // Variaciones de "próxima semana"
      'proximo', 'próximo', 'priximo', 'procsimo' // Variaciones de "próximo"
    ];
    const isCalendarQuery = calendarKeywords.some(keyword => lowerMessage.includes(keyword));
    // ***** FIN CALENDAR KEYWORDS ACTUALIZADAS *****

    const scheduleFooterMessage = `\n\nRecuerda que puedo revisar horarios para los próximos ${DAYS_TO_QUERY_CALENDAR} días aproximadamente desde la fecha que me indiques. Para fechas más lejanas o cualquier otra duda, ¡escríbenos por WhatsApp al 👉 +56 9 8996 7350 y te ayudamos con más detalle! 😊`;

    if (isCalendarQuery) {
      console.log('⏳ Detectada consulta de calendario');
      const calendar = await getCalendarClient();
      const serverNowUtc = new Date();

      let targetDateForDisplay = null; 
      let targetHourChile = null;
      let targetMinuteChile = 0;
      let timeOfDay = null;

      const currentYearChile = parseInt(new Intl.DateTimeFormat('en-US', { year: 'numeric', timeZone: 'America/Santiago' }).format(serverNowUtc), 10);
      const currentMonthChile = parseInt(new Intl.DateTimeFormat('en-US', { month: 'numeric', timeZone: 'America/Santiago' }).format(serverNowUtc), 10) -1; 
      const currentDayOfMonthChile = parseInt(new Intl.DateTimeFormat('en-US', { day: 'numeric', timeZone: 'America/Santiago' }).format(serverNowUtc), 10);
      
      const todayChile0000UtcTimestamp = Date.UTC(currentYearChile, currentMonthChile, currentDayOfMonthChile, 0 - CHILE_UTC_OFFSET_HOURS, 0, 0, 0);
      const refDateForTargetCalc = new Date(todayChile0000UtcTimestamp);
      const actualCurrentDayOfWeekInChile = refDateForTargetCalc.getUTCDay();
      
      const isProximoQuery = lowerMessage.includes('proximo') || lowerMessage.includes('próximo') || lowerMessage.includes('priximo') || lowerMessage.includes('procsimo');
      const isAnyNextWeekIndicator = lowerMessage.includes('proxima semana') || lowerMessage.includes('próxima semana') || lowerMessage.includes('prixima semana') || lowerMessage.includes('procsima semana') || lowerMessage.includes('proxima semama');

      let specificDayKeywordIndex = -1;
      const dayKeywordsList = [ 
        { keyword: 'domingo', index: 0 }, { keyword: 'lunes', index: 1 }, 
        { keyword: 'martes', index: 2 }, { keyword: 'miercoles', index: 3 }, 
        { keyword: 'miércoles', index: 3 }, { keyword: 'jueves', index: 4 }, 
        { keyword: 'viernes', index: 5 }, { keyword: 'sabado', index: 6 }, { keyword: 'sábado', index: 6 }
      ];

      for (const dayInfo of dayKeywordsList) {
        if (lowerMessage.includes(dayInfo.keyword)) {
          specificDayKeywordIndex = dayInfo.index;
          break;
        }
      }
      
      // ***** LÓGICA DE FECHA OBJETIVO REFINADA *****
      if (lowerMessage.includes('hoy')) {
        targetDateForDisplay = new Date(refDateForTargetCalc);
      } else if (lowerMessage.includes('mañana') && !lowerMessage.includes('pasado mañana')) {
        targetDateForDisplay = new Date(refDateForTargetCalc);
        targetDateForDisplay.setUTCDate(targetDateForDisplay.getUTCDate() + 1);
      } else if (specificDayKeywordIndex !== -1) { // Si se mencionó un día de la semana
        targetDateForDisplay = new Date(refDateForTargetCalc); // Partir de hoy (Chile 00:00 UTC equiv)
        let daysToAdd = specificDayKeywordIndex - actualCurrentDayOfWeekInChile;

        if (daysToAdd < 0) { 
          daysToAdd += 7; 
        }
        
        // Si se pide explícitamente "próxima semana" Y el día calculado aún está en esta semana (daysToAdd < 7),
        // O si se pide "próximo [día de hoy]" (daysToAdd === 0 && isProximoQuery)
        // entonces forzar el salto a la semana siguiente.
        if ((isAnyNextWeekIndicator && daysToAdd < 7) || (daysToAdd === 0 && isProximoQuery)) {
          daysToAdd += 7;
        } else if (daysToAdd === 0 && !isProximoQuery && serverNowUtc.getUTCHours() >= (19 - CHILE_UTC_OFFSET_HOURS)) {
          // Si es hoy, no se pidió "próximo", y ya es tarde para ese día, ir a la próxima semana.
          daysToAdd += 7;
        }
        targetDateForDisplay.setUTCDate(targetDateForDisplay.getUTCDate() + daysToAdd);
      } else if (isAnyNextWeekIndicator) { // "próxima semana" genérico, sin día específico
          targetDateForDisplay = new Date(refDateForTargetCalc);
          let daysUntilNextMonday = (1 - actualCurrentDayOfWeekInChile + 7) % 7;
          if (daysUntilNextMonday === 0) daysUntilNextMonday = 7; 
          targetDateForDisplay.setUTCDate(targetDateForDisplay.getUTCDate() + daysUntilNextMonday); 
      }
      // Si targetDateForDisplay sigue null, la búsqueda será genérica desde hoy.
      // ***** FIN LÓGICA DE FECHA OBJETIVO REFINADA *****


      if (targetDateForDisplay) {
        console.log(`🎯 Fecha Objetivo (para mostrar y filtrar): ${new Intl.DateTimeFormat('es-CL', { dateStyle: 'full', timeZone: 'America/Santiago' }).format(targetDateForDisplay)} (UTC: ${targetDateForDisplay.toISOString()})`);
        const futureLimitCheckDate = new Date(refDateForTargetCalc); // Comparamos desde el inicio del día de hoy en Chile
        futureLimitCheckDate.setUTCDate(futureLimitCheckDate.getUTCDate() + MAX_DAYS_FOR_USER_REQUEST);

        if (targetDateForDisplay >= futureLimitCheckDate) {
            const formattedDateAsked = new Intl.DateTimeFormat('es-CL', { dateStyle: 'long', timeZone: 'America/Santiago' }).format(targetDateForDisplay);
            let reply = `¡Entiendo que buscas para el ${formattedDateAsked}! 😊 Por ahora, mi calendario mental llega hasta unos ${MAX_DAYS_FOR_USER_REQUEST} días en el futuro (aprox. ${Math.floor(MAX_DAYS_FOR_USER_REQUEST / 7)} semanas).`;
            console.log('✅ Respuesta generada (fecha demasiado lejana):', reply);
            // No retornamos aquí, dejamos que la búsqueda proceda y si no encuentra nada, el footer se añade abajo.
            // O mejor, sí retornamos para ser explícitos.
            return res.status(200).json({ response: reply + scheduleFooterMessage });
        }
      }
      
      const targetDateIdentifierForSlotFilter = targetDateForDisplay ? getDayIdentifier(targetDateForDisplay, 'America/Santiago') : null;
      // ... (El resto del código se mantiene igual que en la respuesta #44, que generó los logs correctos para Jueves y Viernes)
      // ... Copia desde aquí (línea de "if(targetDateIdentifierForSlotFilter) console.log(...)")
      // ... hasta el final del bloque "if (isCalendarQuery)" de la respuesta #44.
      // ... La parte de OpenAI y el catch final también se mantienen.
      // INICIO DE LA LÓGICA QUE SE MANTIENE (DE RESPUESTA #44)
      if(targetDateIdentifierForSlotFilter) console.log(`🏷️ Identificador de Fecha para Filtro de Slots (Chile YAML-MM-DD): ${targetDateIdentifierForSlotFilter}`);
      
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
      if (!targetHourChile && !isAnyNextWeekIndicator && !isProximoQuery && !(targetDateForDisplay && targetDateForDisplay > refDateForTargetCalc) ) { 
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
            reply += ` está fuera de nuestro horario de atención (que es de 10:00 a 19:30). ¿Te gustaría buscar dentro de ese rango?`;
            console.log('✅ Respuesta generada (fuera de horario):', reply);
            return res.status(200).json({ response: reply + scheduleFooterMessage });
        }
      }

      let calendarQueryStartUtc;
      if (targetDateForDisplay) { 
          calendarQueryStartUtc = new Date(targetDateForDisplay.getTime());
      } else { 
          calendarQueryStartUtc = new Date(refDateForTargetCalc.getTime()); 
      }
      
      const calendarQueryEndUtc = new Date(calendarQueryStartUtc);
      calendarQueryEndUtc.setUTCDate(calendarQueryStartUtc.getUTCDate() + DAYS_TO_QUERY_CALENDAR); 
      
      console.log(`🗓️ Google Calendar Query: De ${calendarQueryStartUtc.toISOString()} a ${calendarQueryEndUtc.toISOString()}`);

      const googleResponse = await calendar.events.list({
        calendarId: 'primary',
        timeMin: calendarQueryStartUtc.toISOString(),
        timeMax: calendarQueryEndUtc.toISOString(),
        singleEvents: true,
        orderBy: 'startTime'
      });

      const busySlots = googleResponse.data.items
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
      console.log(`Found ${busySlots.length} busy slots from Google Calendar.`);
      if (busySlots.length > 0) {
        console.log("DEBUG: Contenido de busySlots (eventos UTC de Google Calendar):");
        busySlots.forEach((bs, index) => {
          const eventStartDate = new Date(bs.start);
          const eventEndDate = new Date(bs.end);
          if (eventEndDate > calendarQueryStartUtc && eventStartDate < calendarQueryEndUtc) {
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
      if (targetDateForDisplay) {
          baseIterationDateDayUtcStart = new Date(targetDateForDisplay);
      } else { 
          baseIterationDateDayUtcStart = new Date(refDateForTargetCalc);
      }

      for (let i = 0; i < DAYS_TO_QUERY_CALENDAR; i++) { 
        const currentDayProcessingUtcStart = new Date(baseIterationDateDayUtcStart);
        currentDayProcessingUtcStart.setUTCDate(baseIterationDateDayUtcStart.getUTCDate() + i);
        
        for (const timeChileStr of WORKING_HOURS_CHILE_STR) {
          const [hChile, mChile] = timeChileStr.split(':').map(Number);

          if (targetHourChile !== null) {
            if (hChile !== targetHourChile || mChile !== targetMinuteChile) continue;
          } else if (timeOfDay && !(isAnyNextWeekIndicator && !targetDateIdentifierForSlotFilter && !isProximoQuery) ) { 
            if (timeOfDay === 'morning' && (hChile < 10 || hChile >= 14)) continue;
            if (timeOfDay === 'afternoon' && (hChile < 14 || hChile > 19 || (hChile === 19 && mChile > 30))) continue;
          }

          const slotStartUtc = convertChileTimeToUtc(currentDayProcessingUtcStart, hChile, mChile);
          if (isNaN(slotStartUtc.getTime())) { console.error("Slot UTC inválido:", currentDayProcessingUtcStart, hChile, mChile); continue; }
          
          const slightlyFutureServerNowUtc = new Date(serverNowUtc.getTime() + 5 * 60 * 1000);
          if (slotStartUtc < slightlyFutureServerNowUtc) continue;

          const slotDayIdentifierInChile = getDayIdentifier(slotStartUtc, 'America/Santiago');

          if (targetDateIdentifierForSlotFilter) {
            if (slotDayIdentifierInChile !== targetDateIdentifierForSlotFilter) {
              continue; 
            }
          }

          const slotEndUtc = new Date(slotStartUtc);
          slotEndUtc.setUTCMinutes(slotEndUtc.getUTCMinutes() + 30);
          const isBusy = busySlots.some(busy => slotStartUtc.getTime() < busy.end && slotEndUtc.getTime() > busy.start);
          
          if (!isBusy) { 
            const formattedSlot = new Intl.DateTimeFormat('es-CL', {
                weekday: 'long', day: 'numeric', month: 'long',
                hour: '2-digit', minute: '2-digit', timeZone: 'America/Santiago'
            }).format(slotStartUtc);
            
            if (!targetDateIdentifierForSlotFilter && !targetHourChile) { 
                if (availableSlotsOutput.length < 10) { 
                    if (!processedDaysForGenericQuery.has(slotDayIdentifierInChile) || availableSlotsOutput.length < 2) {
                         availableSlotsOutput.push(formattedSlot);
                         processedDaysForGenericQuery.add(slotDayIdentifierInChile);
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
            if (targetHourChile !== null || availableSlotsOutput.length >= MAX_SUGGESTIONS ) break; 
        }
        if (availableSlotsOutput.length >= MAX_SUGGESTIONS && !targetDateIdentifierForSlotFilter && !targetHourChile && processedDaysForGenericQuery.size >=2) break; 
      }
      
      if(targetDateIdentifierForSlotFilter) {
          console.log(`🔎 Slots encontrados para el día de Chile ${targetDateIdentifierForSlotFilter}: ${availableSlotsOutput.length}`);
      } else {
          console.log(`🔎 Slots encontrados en búsqueda general (próximos ${DAYS_TO_QUERY_CALENDAR} días): ${availableSlotsOutput.length}`);
      }
      
      let reply = '';

      if (targetHourChile !== null) { 
        if (availableSlotsOutput.length > 0) {
          reply = `¡Excelente! 🎉 Justo el ${availableSlotsOutput[0]} está libre para ti. ¡Qué buena suerte! Para asegurar tu cita, contáctanos directamente y la reservamos. 😉`;
        } else {
          let specificTimeQuery = "";
          if(targetDateForDisplay) specificTimeQuery += `${new Intl.DateTimeFormat('es-CL', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Santiago' }).format(targetDateForDisplay)} `;
          specificTimeQuery += `a las ${targetHourChile.toString().padStart(2,'0')}:${targetMinuteChile.toString().padStart(2,'0')}`;
          reply = `¡Uy! Justo ${specificTimeQuery} no me quedan espacios. 😕 ¿Te gustaría que revise otro horario o quizás otro día?`;
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
                if (slotsByDay[dayName].length < 2) { 
                    slotsByDay[dayName].push(slot);
                }
            }
            let count = 0;
            for (const day in slotsByDay) { 
                for(const slot of slotsByDay[day]){
                    if(count < MAX_SUGGESTIONS){
                        finalSuggestions.push(slot);
                        count++;
                    } else { break; }
                }
                if (count >= MAX_SUGGESTIONS) break; 
            }
        } else { 
            finalSuggestions = availableSlotsOutput.slice(0, MAX_SUGGESTIONS);
        }

        reply = `${intro}\n- ${finalSuggestions.join('\n- ')}`;
        
        if (availableSlotsOutput.length > finalSuggestions.length && finalSuggestions.length > 0) { 
           const remaining = availableSlotsOutput.length - finalSuggestions.length;
           if (remaining > 0) {
             reply += `\n\n(Y ${remaining} más... ¡para que tengas de dónde elegir! 😉)`;
           }
        }
      } else { 
        reply = '¡Pucha! 😔 Parece que no tengo horas libres';
        if (targetDateForDisplay) {
            reply += ` para el ${new Intl.DateTimeFormat('es-CL', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Santiago' }).format(targetDateForDisplay)}`;
        } else if (isAnyNextWeekIndicator) {
            reply += ` para la próxima semana`;
        }
        if (timeOfDay === 'morning') reply += ' por la mañana';
        if (timeOfDay === 'afternoon') reply += ' por la tarde';
        if (targetHourChile !== null && !targetDateForDisplay && !isAnyNextWeekIndicator) reply += ` a las ${targetHourChile.toString().padStart(2,'0')}:${targetMinuteChile.toString().padStart(2,'0')}`
        
        if (targetDateForDisplay || timeOfDay || targetHourChile || isAnyNextWeekIndicator) {
             reply += '.';
        } else { 
            reply += ` dentro de los próximos ${DAYS_TO_QUERY_CALENDAR} días.`;
        }
        reply += ' ¿Te animas a que busquemos en otra fecha u horario? ¡Seguro encontramos algo! 👍';
      }
      
      reply += scheduleFooterMessage; 

      console.log('✅ Respuesta generada:', reply);
      return res.status(200).json({ response: reply });
      // FIN DE LA LÓGICA DE CALENDARIO
    } 

    // --- Si no es consulta de calendario, usar OpenAI ---
    console.log('💡 Consulta normal, usando OpenAI');
    const systemPrompt = process.env.RIGBOT_PROMPT || 
`Eres Rigbot, el asistente virtual de la consulta quiropráctica Rigquiropráctico, atendido por el quiropráctico Roberto Ibacache en Copiapó, Chile.
Tu rol es entregar información clara, profesional, cálida y empática a quienes consultan por servicios quiroprácticos, y sugerir horarios disponibles usando el calendario conectado.

No agendas directamente, no recopilas datos personales ni confirmas pagos.
Nunca inventes información. Solo responde con lo que indican estas instrucciones.
Siempre invita al paciente a escribir directamente al WhatsApp 👉 +56 9 8996 7350 para continuar el proceso con un humano.

FUNCIONES PRINCIPALES
- Si el usuario pregunta por disponibilidad general o para un día/semana/mes específico, consulta los horarios usando la lógica de calendario interna.
- Si se encuentran horarios, sugiere hasta 3-5 horarios concretos. Si el usuario pidió un día/franja específica, enfócate en eso.
- Si el usuario pide una hora específica y está disponible, confírmala.
- Si el usuario pide una hora específica y NO está disponible, informa que no está e idealmente sugiere alternativas cercanas SI LAS HAY para ESE MISMO DÍA. Si no hay alternativas ese día para esa hora, simplemente informa que no está disponible para esa hora y día.
- Si no se encuentran horarios para la consulta específica, informa claramente que no hay disponibilidad para esos criterios.
- Siempre finaliza las consultas de horario (encuentres o no) con: "Recuerda que puedo revisar horarios para los próximos 7 días aproximadamente. Para fechas más lejanas o cualquier otra duda, ¡escríbenos por WhatsApp al 👉 +56 9 8996 7350 y te ayudamos con más detalle! 😊". No ofrezcas buscar otros horarios tú mismo a menos que el usuario lo pida.

INFORMACIÓN IMPORTANTE
PRECIOS
1 sesión: $40.000
Pack 2 sesiones: $70.000
Pack 3 sesiones: $100.000
Pack 5 sesiones: $160.000
Pack 10 sesiones: $300.000
Los packs pueden ser compartidos entre personas distintas si se pagan en un solo abono.

DIRECCIÓN
Atendemos en Copiapó, en el Centro de Salud Fleming, Van Buren 129.
Si quieres más información o agendar, escribe directamente al WhatsApp 👉 +56 9 8996 7350

¿QUÉ ES LA QUIROPRAXIA?
Si el paciente lo pregunta, comparte este video:
https://youtu.be/EdEZyZUDAw0 (Nota: Este enlace es un placeholder, reemplázalo por el real si existe)

ESTILO DE COMUNICACIÓN
Usa un estilo conversacional cálido, informal pero profesional. 
No repitas siempre la misma estructura. Varía tus respuestas. 
Si un usuario es simpático o usa humor, puedes ser un poco más cercano. 
Nunca seas frío ni robótico. Siempre busca generar una experiencia amable y humana.

Usa siempre un lenguaje amable, claro, empático, cálido y confiable.
Eres un asistente experto y servicial, pero nunca frío ni robótico.`;

    const chatResponse = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message }
      ]
    });

    const gptReply = chatResponse.choices[0].message.content.trim();
    return res.status(200).json({ response: gptReply });

  } catch (error) {
    console.error('❌ Error en Rigbot:', error);
    console.error(error.stack);
    return res.status(500).json({ error: 'Ocurrió un error en Rigbot. ' + error.message });
  }
}