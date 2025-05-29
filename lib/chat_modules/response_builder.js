// /lib/chat_modules/response_builder.js
import { getWhatsappContactMessage, getWhatsappDerivationSuffix } from '@/lib/chat_modules/messageUtils.js';
import { convertChileTimeToUtc, getDayIdentifier, CHILE_UTC_OFFSET_HOURS } from '@/lib/chat_modules/dateTimeUtils.js';
import { WHATSAPP_FALLBACK_PLACEHOLDER } from '@/lib/chat_modules/config_manager.js';

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
    isAnyNextWeekIndicator 
  } = queryDetails;
  
  let replyCalendar = '';
  const slightlyFutureServerNowUtcForResponse = new Date(serverNowUtc.getTime() + 1 * 60 * 1000); 

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
  
  if (targetDateIdentifierForSlotFilter && availableSlotsOutput) { 
      console.log(`🔎 Slots en availableSlotsOutput para ${requestClientId} el día ${targetDateIdentifierForSlotFilter}: ${availableSlotsOutput.length} (response_builder)`); 
  } else if (availableSlotsOutput) {
      console.log(`🔎 Slots en availableSlotsOutput para ${requestClientId} en búsqueda genérica: ${availableSlotsOutput.length} (response_builder)`);
  }


  if (targetHourChile !== null) { 
    let specificTimeQueryFormattedForMsg = "";
    const displayDateForMsg = targetDateForDisplay || refDateForTargetCalc;
    specificTimeQueryFormattedForMsg += `${new Intl.DateTimeFormat('es-CL', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Santiago' }).format(displayDateForMsg)} `;
    specificTimeQueryFormattedForMsg += `a las ${targetHourChile.toString().padStart(2, '0')}:${targetMinuteChile.toString().padStart(2, '0')}`;

    const requestedSlotExactMatch = availableSlotsOutput.find(slotString => {
        // Determinar si estamos en el caso específico de Jueves 3pm para logueo detallado
        const isTargetingSpecificForFindLog = (targetHourChile === 15 && targetMinuteChile === 0 &&
            ( (targetDateIdentifierForSlotFilter && targetDateIdentifierForSlotFilter === TOMORROW_DATE_IDENTIFIER_CHILE) || 
              (targetDateForDisplay && getDayIdentifier(targetDateForDisplay, 'America/Santiago') === TOMORROW_DATE_IDENTIFIER_CHILE) )
        );

        if (isTargetingSpecificForFindLog) {
            console.log(`🔍 DEBUG FIND CB [Slot String]: "${slotString}"`);
            const indexOfHour = slotString.indexOf(targetHourChile.toString().padStart(2,'0').slice(-2) + ":" + targetMinuteChile.toString().padStart(2,'0'));
            if (indexOfHour > -1) {
                const excerpt = slotString.substring(indexOfHour, indexOfHour + 12); // "03:00 p. m." o similar
                let charCodes = "";
                for (let k=0; k < excerpt.length; k++) {
                    charCodes += excerpt.charCodeAt(k) + " ";
                }
                console.log(`🔍 DEBUG FIND CB: Excerpt around time: "${excerpt}", Char codes: ${charCodes}`);
            }
        }

        const parts = slotString.split(',');
        if (parts.length < 2) { // Esperamos al menos "..., HH:MM AM/PM"
            if (isTargetingSpecificForFindLog) console.log(`🔍 DEBUG FIND CB: parts.length < 2 para "${slotString}"`);
            return false; 
        }
    
        const timeChunk = parts[parts.length - 1].trim(); 
        const timeRegex = /(\d{1,2}):(\d{2})\s*([ap])\.?m\.?/i; 
        const matchGroups = timeChunk.match(timeRegex);
    
        if (isTargetingSpecificForFindLog) {
            console.log(`🔍 DEBUG FIND CB: timeChunk: "${timeChunk}", timeRegexMatch:`, matchGroups);
        }
    
        if (matchGroups) {
            let slotH = parseInt(matchGroups[1], 10);
            const slotM = parseInt(matchGroups[2], 10);
            const period = matchGroups[3].toLowerCase(); 
    
            if (isTargetingSpecificForFindLog) {
                console.log(`🔍 DEBUG FIND CB: slotH=${slotH}, slotM=${slotM}, period="${period}"`);
            }
    
            if (period === 'p' && slotH >= 1 && slotH <= 11) slotH += 12;
            if (period === 'a' && slotH === 12) slotH = 0; 
            
            if (isTargetingSpecificForFindLog) {
                console.log(`🔍 DEBUG FIND CB: slotH convertido=${slotH}. Comparando con targetHourChile=${targetHourChile}`);
            }
            const matchResult = (slotH === targetHourChile && slotM === targetMinuteChile);
            if (isTargetingSpecificForFindLog) {
                 console.log(`🔍 DEBUG FIND CB: Resultado de la comparación: ${matchResult}`);
            }
            return matchResult;
        }
        if (isTargetingSpecificForFindLog) {
            console.log(`🔍 DEBUG FIND CB: timeRegexMatch fue null para timeChunk "${timeChunk}".`);
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
  } else if (availableSlotsOutput && availableSlotsOutput.length > 0) { 
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
                const localCurrentYear = currentYearChile || new Date().getFullYear();
                const dateA = new Date(a.split(', ')[1].replace(/ de /g, ' ') + " " + localCurrentYear);
                const dateB = new Date(b.split(', ')[1].replace(/ de /g, ' ') + " " + localCurrentYear);
                return dateA - dateB;
            } catch(e) { 
                console.error("Error sorting day keys:", e);
                return 0; 
            }
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
        replyCalendar += `\n\nPara reservar alguna o si buscas otra opción,${getWhatsappDerivationSuffix(effectiveConfig.whatsappNumber, WHATSAPP_FALLBACK_PLACEHOLDER)}`;
    } else { 
         replyCalendar = '¡Pucha! 😔 Parece que no tengo horas libres';
        if (targetDateForDisplay) {
            replyCalendar += ` para el ${new Intl.DateTimeFormat('es-CL', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Santiago' }).format(targetDateForDisplay)}`;
        } else if (isAnyNextWeekIndicator) { replyCalendar += ` para la próxima semana`; }
        if (timeOfDay === 'morning') replyCalendar += ' por la mañana'; if (timeOfDay === 'afternoon') replyCalendar += ' por la tarde';
        replyCalendar += `. ¿Te animas a que busquemos en otra fecha u horario?${getWhatsappContactMessage(effectiveConfig.whatsappNumber, WHATSAPP_FALLBACK_PLACEHOLDER)} ¡Seguro te podemos ayudar!`;
    }
  } else {
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