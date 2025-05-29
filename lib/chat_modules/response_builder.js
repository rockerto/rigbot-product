// /lib/chat_modules/response_builder.js
import { getWhatsappContactMessage, getWhatsappDerivationSuffix } from '@/lib/chat_modules/messageUtils.js';
import { convertChileTimeToUtc, getDayIdentifier } from '@/lib/chat_modules/dateTimeUtils.js'; // Necesario para buscar alternativas
import { WHATSAPP_FALLBACK_PLACEHOLDER } from '@/lib/chat_modules/config_manager.js'; // Para los helpers de WhatsApp

// Esta constante es usada solo aquí para buscar alternativas, podría quedarse o moverse a un config si se usa en más sitios.
const WORKING_HOURS_CHILE_STR_FOR_ALTERNATIVES = [
  '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30',
  '14:00', '14:30', '15:00', '15:30', '16:00', '16:30', '17:00', '17:30',
  '18:00', '18:30', '19:00', '19:30'
];

export function buildCalendarResponse(
    availableSlotsOutput, 
    queryDetails, 
    effectiveConfig, 
    serverNowUtc, 
    refDateForTargetCalc,
    busySlots, 
    currentYearChile, 
    requestClientId
) {
  const { 
    targetDateForDisplay, 
    targetHourChile, 
    targetMinuteChile, 
    timeOfDay, 
    targetDateIdentifierForSlotFilter, 
    TOMORROW_DATE_IDENTIFIER_CHILE,
    isGenericNextWeekSearch,
    // isAnyNextWeekIndicator // Necesitamos pasar esto desde parseDateTimeQuery
  } = queryDetails;
  
  // Recrear isAnyNextWeekIndicator si no se pasa, o mejor, asegurarse que parseDateTimeQuery lo devuelva
  // Para simplificar, asumimos que si isGenericNextWeekSearch es true, implica una búsqueda de "próxima semana"
  const isAnyNextWeekIndicator = queryDetails.isAnyNextWeekIndicator || isGenericNextWeekSearch;


  let replyCalendar = '';
  const slightlyFutureServerNowUtcForResponse = new Date(serverNowUtc.getTime() + 1 * 60 * 1000); 

  // Condición para activar logs de depuración detallados para el caso Jueves 3pm
  const isDebuggingQueryForResponseFind = (targetHourChile === 15 && targetMinuteChile === 0 &&
    (targetDateIdentifierForSlotFilter === TOMORROW_DATE_IDENTIFIER_CHILE ||
      (targetDateForDisplay && getDayIdentifier(targetDateForDisplay, 'America/Santiago') === TOMORROW_DATE_IDENTIFIER_CHILE)));

  if (isDebuggingQueryForResponseFind) {
    console.log(`\n🔍 DEBUGGING "MAÑANA JUEVES 3PM" RESPONSE PREP (response_builder - ClientId: ${requestClientId}):`);
    console.log(`   targetHourChile: ${targetHourChile}, targetMinuteChile: ${targetMinuteChile}`);
    console.log(`   targetDateIdentifierForSlotFilter: ${targetDateIdentifierForSlotFilter}`);
    console.log(`   AvailableSlotsOutput before .find() for requestedSlotExactMatch (length ${availableSlotsOutput.length}):`);
    availableSlotsOutput.forEach((s, idx) => console.log(`    - Slot ${idx}: "${s}" (length: ${s.length})`));
    console.log(`🔍 END DEBUGGING "MAÑANA JUEVES 3PM" RESPONSE PREP\n`);
  }

  if (targetDateIdentifierForSlotFilter && availableSlotsOutput) { // Log general, no específico de Jueves 3pm
      console.log(`🔎 Slots en availableSlotsOutput para ${requestClientId} el día ${targetDateIdentifierForSlotFilter}: ${availableSlotsOutput.length} (antes de formateo final de respuesta)`);
  } else if (availableSlotsOutput) {
      console.log(`🔎 Slots en availableSlotsOutput para ${requestClientId} en búsqueda genérica: ${availableSlotsOutput.length} (antes de formateo final de respuesta)`);
  }


  if (targetHourChile !== null) { // Usuario pidió una HORA ESPECÍFICA
    let specificTimeQueryFormattedForMsg = "";
    const displayDateForMsg = targetDateForDisplay || refDateForTargetCalc;
    specificTimeQueryFormattedForMsg += `${new Intl.DateTimeFormat('es-CL', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Santiago' }).format(displayDateForMsg)} `;
    specificTimeQueryFormattedForMsg += `a las ${targetHourChile.toString().padStart(2, '0')}:${targetMinuteChile.toString().padStart(2, '0')}`;

    const requestedSlotExactMatch = availableSlotsOutput.find(slotString => {
      if (isDebuggingQueryForResponseFind) {
        console.log(`🔍 DEBUG FIND CB [Slot String]: "${slotString}" (length: ${slotString.length})`);
      }
      const normalizedSlotString = slotString.replace(/[\s\u00A0\u202F]+/g, ' '); // Normalizar múltiples tipos de espacio
      // Regex ajustado para \d{1,2} y el espacio más explícito y el am/pm más flexible
      const timePartMatch = normalizedSlotString.match(/(\d{1,2}:\d{2})(?:\s|\u00A0|\u202F)+(a\.?m\.?|p\.?m\.?)/i);

      if (isDebuggingQueryForResponseFind) {
        console.log(`🔍 DEBUG FIND CB: Normalized string for regex: "${normalizedSlotString}"`);
        console.log(`🔍 DEBUG FIND CB: timePartMatch (using /(\\d{1,2}:\\d{2})(?:\\s|\\u00A0|\\u202F)+(a\\.?m\\.?|p\\.?m\\.?)/i ):`, timePartMatch);
      }

      if (timePartMatch) {
        const slotHourMin = timePartMatch[1];
        let [slotH, slotM] = slotHourMin.split(':').map(Number);
        const slotPeriod = timePartMatch[2] ? timePartMatch[2].toLowerCase().replace(/\./g, '').trim() : null;

        if (isDebuggingQueryForResponseFind) {
          console.log(`🔍 DEBUG FIND CB: slotH=${slotH}, slotM=${slotM}, slotPeriod="${slotPeriod}" (original from regex: "${timePartMatch[2]}")`);
        }

        if (slotPeriod) {
          if (slotPeriod === 'pm' && slotH >= 1 && slotH <= 11) slotH += 12;
          if (slotPeriod === 'am' && slotH === 12) slotH = 0;
        }

        if (isDebuggingQueryForResponseFind) {
          console.log(`🔍 DEBUG FIND CB: slotH convertido=${slotH}. Comparando con targetHourChile=${targetHourChile}`);
        }
        const match = (slotH === targetHourChile && slotM === targetMinuteChile);
        if (isDebuggingQueryForResponseFind) {
          console.log(`🔍 DEBUG FIND CB: Resultado de la comparación: ${match}`);
        }
        return match;
      }
      if (isDebuggingQueryForResponseFind) {
        console.log(`🔍 DEBUG FIND CB: timePartMatch fue null para "${normalizedSlotString}".`);
      }
      return false;
    });

    if (isDebuggingQueryForResponseFind) { 
        console.log("🔍 DEBUG FIND: Resultado de requestedSlotExactMatch:", requestedSlotExactMatch);
    }

    if (requestedSlotExactMatch) {
      replyCalendar = `¡Excelente! 🎉 Justo el ${requestedSlotExactMatch} está libre para ti.${getWhatsappDerivationSuffix(effectiveConfig.whatsappNumber, WHATSAPP_FALLBACK_PLACEHOLDER)}`;
    } else {
      replyCalendar = `¡Uy! Justo ${specificTimeQueryFormattedForMsg} no me quedan espacios. 😕`;
      let alternativesForTheDay = [];
      const dayToSearchAlternatives = targetDateForDisplay || refDateForTargetCalc;

      if (dayToSearchAlternatives) {
        const shouldLogAlternativesSearch = (targetHourChile === 15 && targetMinuteChile === 0 &&
          (getDayIdentifier(dayToSearchAlternatives, 'America/Santiago') === TOMORROW_DATE_IDENTIFIER_CHILE))
          || process.env.NODE_ENV === 'development';

        if (shouldLogAlternativesSearch) {
          console.log(`DEBUG (response_builder): Hora específica ${targetHourChile}:${targetMinuteChile} no disponible para ${getDayIdentifier(dayToSearchAlternatives, 'America/Santiago')}. Buscando alternativas para ese día. ClientId: ${requestClientId}`);
        }
        for (const timeChileStr of WORKING_HOURS_CHILE_STR_FOR_ALTERNATIVES) {
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
      } else if (targetDateForDisplay) {
        replyCalendar += ` Y no encuentro más horarios disponibles para ese día.`;
      }
      replyCalendar += ` ¿Te animas a que busquemos en otra fecha u horario?${getWhatsappContactMessage(effectiveConfig.whatsappNumber, WHATSAPP_FALLBACK_PLACEHOLDER)}`;
    }
  } else if (availableSlotsOutput && availableSlotsOutput.length > 0) { // Búsqueda general (sin hora específica) Y SÍ se encontraron slots
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
    if (!targetDateIdentifierForSlotFilter && !targetHourChile) { // Solo aplicar lógica de diversidad de días si es una búsqueda muy genérica
        const slotsByDay = {};
        for (const slot of availableSlotsOutput) {
            const dayKey = slot.split(',').slice(0,2).join(','); 
            if (!slotsByDay[dayKey]) slotsByDay[dayKey] = [];
            if (slotsByDay[dayKey].length < 2) { slotsByDay[dayKey].push(slot); } 
        }
        let count = 0;
        const sortedDayKeys = Object.keys(slotsByDay).sort((a, b) => {
            try { 
                const localCurrentYear = currentYearChile || new Date().getFullYear(); // Asegurar que currentYearChile esté disponible
                const dateA = new Date(a.split(', ')[1].replace(/ de /g, ' ') + " " + localCurrentYear);
                const dateB = new Date(b.split(', ')[1].replace(/ de /g, ' ') + " " + localCurrentYear);
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
            
    if (finalSuggestions.length === 0 && availableSlotsOutput.length > 0) { // Fallback si la lógica de diversidad no arrojó nada pero había slots
        finalSuggestions = availableSlotsOutput.slice(0, effectiveConfig.maxSuggestions);
    }
    
    if (finalSuggestions.length > 0) {
        replyCalendar = `${intro}\n- ${finalSuggestions.join('\n- ')}`;
        if (availableSlotsOutput.length > finalSuggestions.length && finalSuggestions.length > 0 && finalSuggestions.length < effectiveConfig.maxSuggestions) { 
            const remaining = availableSlotsOutput.length - finalSuggestions.length;
            if (remaining > 0) { replyCalendar += `\n\n(Y ${remaining} más... ¡para que tengas de dónde elegir! 😉)`; }
        }
        replyCalendar += `\n\nPara reservar alguna o si buscas otra opción,${getWhatsappDerivationSuffix(effectiveConfig.whatsappNumber, WHATSAPP_FALLBACK_PLACEHOLDER)}`;
    } else { 
         replyCalendar = '¡Pucha! 😔 Parece que no tengo horas libres';
        if (targetDateForDisplay) {
            replyCalendar += ` para el ${new Intl.DateTimeFormat('es-CL', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Santiago' }).format(targetDateForDisplay)}`;
        } else if (isAnyNextWeekIndicator) { replyCalendar += ` para la próxima semana`; }
        if (timeOfDay === 'morning') replyCalendar += ' por la mañana'; if (timeOfDay === 'afternoon') replyCalendar += ' por la tarde';
        replyCalendar += `. ¿Te animas a que busquemos en otra fecha u horario?${getWhatsappContactMessage(effectiveConfig.whatsappNumber, WHATSAPP_FALLBACK_PLACEHOLDER)} ¡Seguro te podemos ayudar!`;
    }
  } else { // Búsqueda general Y NO se encontraron slots en availableSlotsOutput
    replyCalendar = '¡Pucha! 😔 Parece que no tengo horas libres';
    if (targetDateForDisplay) {
      replyCalendar += ` para el ${new Intl.DateTimeFormat('es-CL', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Santiago' }).format(targetDateForDisplay)}`;
    } else if (isAnyNextWeekIndicator) { replyCalendar += ` para la próxima semana`; }
    if (timeOfDay === 'morning') replyCalendar += ' por la mañana'; if (timeOfDay === 'afternoon') replyCalendar += ' por la tarde';
    if (targetHourChile !== null && !targetDateForDisplay && !isAnyNextWeekIndicator) replyCalendar += ` a las ${targetHourChile.toString().padStart(2, '0')}:${targetMinuteChile.toString().padStart(2, '0')}`
    if (targetDateForDisplay || timeOfDay || targetHourChile || isAnyNextWeekIndicator) { replyCalendar += '.'; }
    else { replyCalendar += ` dentro de los próximos ${effectiveConfig.calendarQueryDays} días.`; }
    replyCalendar += ` ¿Te animas a que busquemos en otra fecha u horario?${getWhatsappContactMessage(effectiveConfig.whatsappNumber, WHATSAPP_FALLBACK_PLACEHOLDER)} ¡Seguro te podemos ayudar!`;
  }
  return replyCalendar;
}