// /lib/chat_modules/date_time_parser.js
import { CHILE_UTC_OFFSET_HOURS, getDayIdentifier } from '@/lib/chat_modules/dateTimeUtils.js';
import { getWhatsappContactMessage } from '@/lib/chat_modules/messageUtils.js';
import { WHATSAPP_FALLBACK_PLACEHOLDER } from '@/lib/chat_modules/config_manager.js';


const monthMap = {
    'ene': 0, 'enero': 0, 'feb': 1, 'febrero': 1, 'mar': 2, 'marzo': 2,
    'abr': 3, 'abril': 3, 'may': 4, 'mayo': 4, 'jun': 5, 'junio': 5,
    'jul': 6, 'julio': 6, 'ago': 7, 'agosto': 7, 'sep': 8, 'septiembre': 8, 'set': 8,
    'oct': 9, 'octubre': 9, 'nov': 10, 'noviembre': 10, 'dic': 11, 'diciembre': 11
};

const calendarKeywords = [ 
    'hora', 'turno', 'disponibilidad', 'agenda', 'cuando', 'horario', 'disponible', 'libre', 'atiendes', 
    'ver', 'revisar', 'chequear', 'consultar', 'lunes', 'martes', 'miercoles', 'miércoles', 'jueves', 
    'viernes', 'sabado', 'sábado', 'domingo', 'hoy', 'mañana', 'tarde', 'a las', 'para el', 
    'tienes algo', 'hay espacio', 'agendar', 'agendamiento', 'proxima semana', 'próxima semana', 
    'prixima semana', 'procsima semana', 'proxima semama', 'proximo', 'próximo', 'priximo', 'procsimo'
];

export function isCalendarQuery(lowerMessage) {
    return calendarKeywords.some(keyword => lowerMessage.includes(keyword));
}

export function parseDateTimeQuery(lowerMessage, effectiveConfig, serverNowUtc, refDateForTargetCalc, requestClientId) {
    let targetDateForDisplay = null; 
    let targetHourChile = null;
    let targetMinuteChile = 0;
    let timeOfDay = null; 
    let isGenericNextWeekSearch = false;
    let specificDateParsed = false;

    const currentYearChile = parseInt(new Intl.DateTimeFormat('en-US', { year: 'numeric', timeZone: 'America/Santiago' }).format(serverNowUtc), 10);
    const currentMonthChile = parseInt(new Intl.DateTimeFormat('en-US', { month: 'numeric', timeZone: 'America/Santiago' }).format(serverNowUtc), 10) -1; 
    const currentDayOfMonthChile = parseInt(new Intl.DateTimeFormat('en-US', { day: 'numeric', timeZone: 'America/Santiago' }).format(serverNowUtc), 10);
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
                  console.log(`DEBUG (date_time_parser): Fecha específica parseada: ${targetDateForDisplay.toISOString()} para el clientId: ${requestClientId}`);
                } else {
                  console.warn(`DEBUG (date_time_parser): Fecha parseada ${dayNumber}/${monthName} (${monthIndex})/${yearToUse} resultó en una fecha inválida, se ignora. ClientId: ${requestClientId}`);
                  targetDateForDisplay = null; 
                }
            }
        } catch (e) {
            console.error(`Error (date_time_parser): parseando fecha específica para ${requestClientId}:`, e);
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
           console.log("DEBUG (date_time_parser): 'mañana' (palabra) presente pero targetDateForDisplay no se seteó y dayKeywordFound era true. Revisar lógica.");
      }
    } else if (isAnyNextWeekIndicator) { 
        targetDateForDisplay = new Date(refDateForTargetCalc);
        let daysUntilNextMonday = (1 - actualCurrentDayOfWeekInChile + 7) % 7;
        if (daysUntilNextMonday === 0 && !isProximoWordQuery) daysUntilNextMonday = 7; 
        targetDateForDisplay.setUTCDate(targetDateForDisplay.getUTCDate() + daysUntilNextMonday); 
        isGenericNextWeekSearch = true; 
    }
    
    if (targetDateForDisplay) {
      console.log(`🎯 Fecha Objetivo (date_time_parser) para ${requestClientId}: ${new Intl.DateTimeFormat('es-CL', { dateStyle: 'full', timeZone: 'America/Santiago' }).format(targetDateForDisplay)} (UTC: ${targetDateForDisplay.toISOString()})`);
      const futureLimitCheckDate = new Date(refDateForTargetCalc); 
      futureLimitCheckDate.setUTCDate(futureLimitCheckDate.getUTCDate() + effectiveConfig.calendarMaxUserRequestDays);
      if (targetDateForDisplay >= futureLimitCheckDate) {
          const formattedDateAsked = new Intl.DateTimeFormat('es-CL', { dateStyle: 'long', timeZone: 'America/Santiago' }).format(targetDateForDisplay);
          let reply = `¡Entiendo que buscas para el ${formattedDateAsked}! 😊 Por ahora, mi calendario mental solo llega hasta unos ${effectiveConfig.calendarMaxUserRequestDays} días en el futuro.${getWhatsappContactMessage(effectiveConfig.whatsappNumber, WHATSAPP_FALLBACK_PLACEHOLDER)} y mis colegas humanos te ayudarán con gusto.`;
          console.log('✅ Respuesta generada (fecha demasiado lejana) por date_time_parser:', reply);
          return { earlyResponse: { response: reply, status: 200 } };
      }
    }
    
    const targetDateIdentifierForSlotFilter = (targetDateForDisplay && !isGenericNextWeekSearch) ? getDayIdentifier(targetDateForDisplay, 'America/Santiago') : null;
    if(targetDateIdentifierForSlotFilter) { console.log(`🏷️ Identificador de Fecha para Filtro (date_time_parser) para ${requestClientId}: ${targetDateIdentifierForSlotFilter}`); } 
    else if (targetDateForDisplay && isGenericNextWeekSearch) { console.log(`🏷️ Búsqueda genérica (date_time_parser) para ${requestClientId} para la semana que comienza el ${getDayIdentifier(targetDateForDisplay, 'America/Santiago')}.`); } 
    else { console.log(`🏷️ Búsqueda genérica desde hoy (date_time_parser) para ${requestClientId}.`); }
    
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
      if(timeOfDay) console.log(`🕒 Franja horaria parseada (date_time_parser) para ${requestClientId}: ${timeOfDay}`);
    }

    const timeMatch = lowerMessage.match(/(\d{1,2})\s*(:(00|30|15|45))?\s*(pm|am|h|hr|hrs)?/i);
    if (timeMatch) {
      console.log(`DEBUG_DTP: timeMatch encontrado: ${JSON.stringify(timeMatch)}`); // LOG NUEVO 1
      let hour = parseInt(timeMatch[1], 10);
      let minute = timeMatch[3] ? parseInt(timeMatch[3], 10) : 0; 
      const isPm = timeMatch[4] && timeMatch[4].toLowerCase() === 'pm';
      const isAm = timeMatch[4] && timeMatch[4].toLowerCase() === 'am';
      if (isPm && hour >= 1 && hour <= 11) hour += 12;
      if (isAm && hour === 12) hour = 0; 
      
      const conditionForSettingHour = (!specificDateParsed || (specificDateParsed && (timeMatch[2] || timeMatch[4])));
      console.log(`DEBUG_DTP: specificDateParsed=${specificDateParsed}, timeMatch[2]=${timeMatch[2]}, timeMatch[4]=${timeMatch[4]}, conditionForSettingHour=${conditionForSettingHour}`); // LOG NUEVO 2

      if (conditionForSettingHour) {
          targetHourChile = hour;
          targetMinuteChile = minute;
          if (targetMinuteChile > 0 && targetMinuteChile < 15) targetMinuteChile = 0; 
          else if (targetMinuteChile >= 15 && targetMinuteChile < 30) targetMinuteChile = 0; 
          else if (targetMinuteChile > 30 && targetMinuteChile < 45) targetMinuteChile = 30; 
          else if (targetMinuteChile >= 45 && targetMinuteChile < 60) targetMinuteChile = 30;
          timeOfDay = null; 
          console.log(`⏰ Hora objetivo (Chile) parseada por timeMatch (date_time_parser) para ${requestClientId}: ${targetHourChile}:${targetMinuteChile.toString().padStart(2,'0')}`);
      } else if (specificDateParsed) {
          console.log(`DEBUG (date_time_parser): timeMatch capturó un número (${timeMatch[1]}) pero se ignoró porque specificDateParsed era true y no había indicadores claros de hora (am/pm, h, :xx). ClientId: ${requestClientId}`);
      }
    } else {
        console.log(`DEBUG_DTP: NO se encontró timeMatch en: "${lowerMessage}"`); // LOG NUEVO 3
    }

    if (specificDateParsed && targetHourChile !== null && timeMatch && !timeMatch[2] && !timeMatch[4]) { 
        console.log(`DEBUG (date_time_parser): Reseteando targetHourChile (${targetHourChile}) porque probablemente vino del número del día. ClientId: ${requestClientId}`);
        targetHourChile = null;
        targetMinuteChile = 0; 
        const tardePattern = /\b(tarde|de tarde|en la tarde)\b/i;
        const mananaPattern = /\b(mañana|de mañana|en la mañana)\b/i;
        if (tardePattern.test(lowerMessage)) timeOfDay = 'afternoon';
        else if (mananaPattern.test(lowerMessage)) timeOfDay = 'morning';
        if(timeOfDay) console.log(`🕒 Franja horaria RE-EVALUADA (date_time_parser) para ${requestClientId}: ${timeOfDay}`);
    }
    
    const WORKING_HOURS_CHILE_NUMERIC = [10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5, 14, 14.5, 15, 15.5, 16, 16.5, 17, 17.5, 18, 18.5, 19, 19.5];
    if (targetHourChile !== null) { 
      const requestedTimeNumeric = targetHourChile + (targetMinuteChile / 60);
      if (!WORKING_HOURS_CHILE_NUMERIC.includes(requestedTimeNumeric) || requestedTimeNumeric < 7 || requestedTimeNumeric > 21) { // Ajustado al nuevo rango 7-21
          let replyPreamble = `¡Ojo! 👀 Parece que las ${targetHourChile.toString().padStart(2,'0')}:${targetMinuteChile.toString().padStart(2,'0')}`;
          if (targetDateForDisplay) { 
              replyPreamble = `¡Ojo! 👀 Parece que el ${new Intl.DateTimeFormat('es-CL', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Santiago' }).format(targetDateForDisplay)} a las ${targetHourChile.toString().padStart(2,'0')}:${targetMinuteChile.toString().padStart(2,'0')}`;
          }
          let reply = `${replyPreamble} está fuera de nuestro horario de atención general (07:00 a 21:00). Aunque la disponibilidad final la veo en el calendario, ¿podrías confirmar si la hora es correcta o buscar dentro de este rango general? También puedes ${getWhatsappContactMessage(effectiveConfig.whatsappNumber, WHATSAPP_FALLBACK_PLACEHOLDER)}`;
          console.log('✅ Respuesta generada (fuera de horario general de chequeo) por date_time_parser:', reply);
          return { earlyResponse: { response: reply, status: 200 } };
      }
    }

    return {
        targetDateForDisplay,
        targetDateIdentifierForSlotFilter,
        targetHourChile,
        targetMinuteChile,
        timeOfDay,
        isGenericNextWeekSearch,
        TOMORROW_DATE_IDENTIFIER_CHILE,
        isAnyNextWeekIndicator 
    };
}