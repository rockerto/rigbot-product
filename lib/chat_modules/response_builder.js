// /lib/chat_modules/response_builder.js
import { getWhatsappContactMessage, getWhatsappDerivationSuffix } from '@/lib/chat_modules/messageUtils.js';
import { convertChileTimeToUtc, getDayIdentifier, CHILE_UTC_OFFSET_HOURS } from '@/lib/chat_modules/dateTimeUtils.js';
import { WHATSAPP_FALLBACK_PLACEHOLDER } from '@/lib/chat_modules/config_manager.js';

const WORKING_HOURS_CHILE_STR_FOR_ALTERNATIVES = [ // Para buscar alternativas
  '07:00', '07:30', '08:00', '08:30', '09:00', '09:30', '10:00', '10:30', 
  '11:00', '11:30', '12:00', '12:30', '13:00', '13:30', '14:00', '14:30', 
  '15:00', '15:30', '16:00', '16:30', '17:00', '17:30', '18:00', '18:30', 
  '19:00', '19:30', '20:00', '20:30', '21:00'
];


export function buildCalendarResponse(
    availableSlotsOutput, // Este array ahora es clave: si targetHourChile se pidió, solo contendrá ESE slot si está libre, o estará vacío.
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
    console.log(`\n🔍 DEBUGGING "MAÑANA (TARGET_DAY) 3PM" RESPONSE PREP (response_builder - ClientId: ${requestClientId}):`);
    console.log(`   targetHourChile: ${targetHourChile}, targetMinuteChile: ${targetMinuteChile}`);
    console.log(`   AvailableSlotsOutput que llega a response_builder (length ${availableSlotsOutput.length}):`);
    availableSlotsOutput.forEach((s, idx) => console.log(`    - Slot ${idx}: "${s}"`));
  }
  
  if (targetHourChile !== null) { // Usuario pidió una HORA ESPECÍFICA
    let specificTimeQueryFormattedForMsg = "";
    const displayDateForMsg = targetDateForDisplay || refDateForTargetCalc;
    specificTimeQueryFormattedForMsg += `${new Intl.DateTimeFormat('es-CL', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Santiago' }).format(displayDateForMsg)} `;
    specificTimeQueryFormattedForMsg += `a las ${targetHourChile.toString().padStart(2, '0')}:${targetMinuteChile.toString().padStart(2, '0')}`;

    // Con el cambio en slot_availability_calculator, si targetHourChile se especificó:
    // - availableSlotsOutput tendrá 1 elemento si el slot está libre.
    // - availableSlotsOutput estará vacío si el slot está ocupado.
    if (availableSlotsOutput.length === 1) { 
      // El slot específico pedido ESTÁ LIBRE
      replyCalendar = `¡Excelente! 🎉 Justo el ${availableSlotsOutput[0]} está libre para ti.${getWhatsappDerivationSuffix(effectiveConfig.whatsappNumber, WHATSAPP_FALLBACK_PLACEHOLDER)}`;
    } else { 
      // El slot específico pedido ESTÁ OCUPADO (o no existe en el rango horario)
      replyCalendar = `¡Uy! Justo ${specificTimeQueryFormattedForMsg} no me quedan espacios. 😕`;
      let alternativesForTheDay = [];
      const dayToSearchAlternatives = targetDateForDisplay || refDateForTargetCalc; // Debería ser targetDateForDisplay

      if (dayToSearchAlternatives) { // Solo buscar alternativas si hay un día claro
        console.log(`DEBUG (response_builder): Hora específica ${targetHourChile}:${targetMinuteChile} no disponible para ${getDayIdentifier(dayToSearchAlternatives, 'America/Santiago')}. Buscando alternativas para ese día. ClientId: ${requestClientId}`);
        
        for (const timeChileStr of WORKING_HOURS_CHILE_STR_FOR_ALTERNATIVES) {
          const [hC, mC] = timeChileStr.split(':').map(Number);
          // No ofrecer la misma hora que se acaba de denegar
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
      } else if (targetDateForDisplay) { // targetDateForDisplay implica que se buscó en un día específico
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
                console.error("Error sorting day keys (response_builder):", e);
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
  } else { // Ni hora específica pedida, ni slots encontrados en la búsqueda general
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