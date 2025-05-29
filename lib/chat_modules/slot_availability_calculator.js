// /lib/chat_modules/slot_availability_calculator.js
import { convertChileTimeToUtc, getDayIdentifier } from '@/lib/chat_modules/dateTimeUtils.js';

const WORKING_HOURS_CHILE_STR = [
  '07:00', '07:30', '08:00', '08:30', '09:00', '09:30', '10:00', '10:30', 
  '11:00', '11:30', '12:00', '12:30', '13:00', '13:30', '14:00', '14:30', 
  '15:00', '15:30', '16:00', '16:30', '17:00', '17:30', '18:00', '18:30', 
  '19:00', '19:30', '20:00', '20:30', '21:00'
];

export async function fetchBusySlots(calendar, timeMinISO, timeMaxISO, requestClientId) {
  console.log(`DEBUG (slot_availability_calculator): Intentando llamar a calendar.events.list para ${requestClientId}...`);
  let googleResponse;
  try {
    googleResponse = await calendar.events.list({
      calendarId: 'primary',
      timeMin: timeMinISO,
      timeMax: timeMaxISO,
      singleEvents: true,
      orderBy: 'startTime'
    });
    console.log(`DEBUG (slot_availability_calculator): Llamada a calendar.events.list completada para ${requestClientId}.`);
  } catch (googleError) {
      console.error(`❌ ERROR (slot_availability_calculator) en calendar.events.list para ${requestClientId}:`, googleError.message);
      throw googleError; 
  }
  
  const eventsFromGoogle = googleResponse?.data?.items || [];
  
  const busySlots = eventsFromGoogle.filter(e => e.status !== 'cancelled')
    .map(e => {
      if (e.start?.dateTime && e.end?.dateTime) { 
        return { start: new Date(e.start.dateTime).getTime(), end: new Date(e.end.dateTime).getTime() };
      }
      return null;
    }).filter(Boolean);
  
  console.log(`INFO (slot_availability_calculator): Se obtuvieron ${eventsFromGoogle.length} eventos y se procesaron ${busySlots.length} busy slots (ignorando all-day) del calendario para ${requestClientId}.`);
  
  if (busySlots.length > 0 && process.env.NODE_ENV === 'development') { 
    console.log(`DEBUG (slot_availability_calculator): Contenido de busySlots (eventos UTC de Google Calendar) para ${requestClientId}:`);
    const queryStartTime = new Date(timeMinISO).getTime();
    const queryEndTime = new Date(timeMaxISO).getTime();
    busySlots.forEach((bs, index) => {
      const eventStartDate = new Date(bs.start);
      const eventEndDate = new Date(bs.end);
      if (bs.end > queryStartTime && bs.start < queryEndTime) { 
        console.log(`  BusySlot ${index}: Start: ${eventStartDate.toISOString()}, End: ${eventEndDate.toISOString()}`);
      }
    });
  }
  return busySlots;
}

export function getAvailableSlots(
    busySlots, 
    queryDetails, 
    effectiveConfig, 
    serverNowUtc, 
    refDateForTargetCalc, // No se usa directamente aquí, pero se pasa a response_builder
    calendarQueryStartUtc, 
    requestClientId
) {
  const { 
    targetDateForDisplay, 
    targetHourChile, 
    targetMinuteChile, 
    timeOfDay, 
    targetDateIdentifierForSlotFilter, 
    TOMORROW_DATE_IDENTIFIER_CHILE // Usado para los logs de debug
  } = queryDetails;

  const availableSlotsOutput = [];
  const processedDaysForGenericQuery = new Set(); // Para la lógica de variedad en búsquedas generales
  let baseIterationDateDayUtcStart;
 
  if (targetDateForDisplay) { 
      baseIterationDateDayUtcStart = new Date(targetDateForDisplay); 
  } else { 
      baseIterationDateDayUtcStart = new Date(calendarQueryStartUtc); 
  }

  console.log(`DEBUG (slot_availability_calculator): Iniciando bucle de ${effectiveConfig.calendarQueryDays} días para ${requestClientId}. Base UTC para iteración: ${baseIterationDateDayUtcStart.toISOString()}`);
  
  for (let i = 0; i < effectiveConfig.calendarQueryDays; i++) {
    const currentDayProcessingUtcStart = new Date(baseIterationDateDayUtcStart);
    currentDayProcessingUtcStart.setUTCDate(baseIterationDateDayUtcStart.getUTCDate() + i);
    const currentDayProcessingIdentifierChile = getDayIdentifier(currentDayProcessingUtcStart, 'America/Santiago');
    
    const isCurrentDayTomorrow = currentDayProcessingIdentifierChile === TOMORROW_DATE_IDENTIFIER_CHILE;
    let isDebuggingThisSpecificSlotIteration = false; 

    if (targetHourChile === 15 && targetMinuteChile === 0 && isCurrentDayTomorrow) {
        isDebuggingThisSpecificSlotIteration = true; 
        console.log(`\n🔍 DEBUGGING "MAÑANA (TARGET_DAY) 3PM" SLOT PROCESSING (slot_availability_calculator - ClientId: ${requestClientId}):`);
        console.log(`   Current Day (Chile): ${currentDayProcessingIdentifierChile}, Slot Time (Chile) being checked: 15:00`);
        console.log(`   User's Target Hour/Minute (Chile): ${targetHourChile}:${targetMinuteChile}`);
    } else if (process.env.NODE_ENV === 'development') { 
        console.log(`\nDEBUG (slot_availability_calculator): Bucle Día i=${i} para ${requestClientId}. Iterando para día UTC: ${currentDayProcessingUtcStart.toISOString()} (Corresponde al día de Chile: ${currentDayProcessingIdentifierChile})`);
        if (targetDateIdentifierForSlotFilter) {
            console.log(`DEBUG (slot_availability_calculator): comparando con targetDateIdentifierForSlotFilter para ${requestClientId}: ${targetDateIdentifierForSlotFilter}`);
        }
    }

    for (const timeChileStr of WORKING_HOURS_CHILE_STR) {
      const [hChile, mChile] = timeChileStr.split(':').map(Number);
      let skipReason = ""; 

      // Aplicar filtros de franja horaria (timeOfDay) SOLO si NO se pidió una hora específica (targetHourChile es null)
      if (targetHourChile === null && timeOfDay) { 
          if (timeOfDay === 'morning' && (hChile < 7 || hChile >= 14)) skipReason = "Filtro franja mañana"; // Ajustado a 7am-2pm para mañana
          if (timeOfDay === 'afternoon' && (hChile < 14 || hChile > 21 || (hChile === 21 && mChile > 0) )) skipReason = "Filtro franja tarde"; // Ajustado a 2pm-9pm para tarde
      }
      // El filtro de hora específica (si targetHourChile NO es null) se maneja al decidir si añadir a availableSlotsOutput
      
      const isCurrentHourTheSpecificDebugHour = (isDebuggingThisSpecificSlotIteration && hChile === 15 && mChile === 0);
      if (skipReason && !isCurrentHourTheSpecificDebugHour ) { continue; } 

      const slotStartUtc = convertChileTimeToUtc(currentDayProcessingUtcStart, hChile, mChile);
      const slotDayIdentifierInChile = getDayIdentifier(slotStartUtc, 'America/Santiago');
      if (isNaN(slotStartUtc.getTime())) { console.log(`    DESCARTADO (slot_availability_calculator) para ${requestClientId}: Slot UTC inválido.`); continue; }
      
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
      
      if (isCurrentHourTheSpecificDebugHour) {
        // ... (Bloque de logging para Jueves/Viernes 3pm - SIN CAMBIOS)
        console.log(`   DEBUG "TARGET_DAY 3PM" (slot_availability_calculator): slotStartUtc=${slotStartUtc.toISOString()}, isBusy=${isBusy}`);
        if (targetHourChile !== null) { 
            const conditionMatches = (hChile === targetHourChile && mChile === targetMinuteChile);
            console.log(`   DEBUG "TARGET_DAY 3PM" (slot_availability_calculator): Condition (hChile === targetHourChile && mChile === targetMinuteChile) is: ${conditionMatches}`);
            if (!isBusy && conditionMatches) {
                console.log(`   DEBUG "TARGET_DAY 3PM" (slot_availability_calculator): ✅ This slot SHOULD be added to availableSlotsOutput for specific time query.`);
            } else if (isBusy) {
                console.log(`   DEBUG "TARGET_DAY 3PM" (slot_availability_calculator): ❌ This slot is busy, so it won't be added.`);
            } else if (!conditionMatches) { 
                console.log(`   DEBUG "TARGET_DAY 3PM" (slot_availability_calculator): ❌ Hour/minute mismatch, so it won't be added for specific time query.`);
            }
        }
        console.log(`   DEBUG "TARGET_DAY 3PM" (slot_availability_calculator): Busy slots around this time for ${currentDayProcessingIdentifierChile} (raw from Google, times in UTC):`);
        busySlots.forEach(bs => {
            const busyStart = new Date(bs.start);
            const busyEnd = new Date(bs.end);
            if (busyStart.getUTCFullYear() === currentDayProcessingUtcStart.getUTCFullYear() &&
                busyStart.getUTCMonth() === currentDayProcessingUtcStart.getUTCMonth() &&
                busyStart.getUTCDate() === currentDayProcessingUtcStart.getUTCDate()) {
                if (slotStartUtc.getTime() < busyEnd.getTime() && slotEndUtc.getTime() > busyStart.getTime()) {
                     console.log(`     - RELEVANTE Busy (para el slot ${hChile}:${mChile}): ${busyStart.toISOString()} to ${busyEnd.toISOString()}`);
                }
            }
        });
        console.log(`🔍 END DEBUGGING "TARGET_DAY 3PM" SLOT PROCESSING (slot_availability_calculator - Loop iteration)\n`);
      }
      if (skipReason && !isCurrentHourTheSpecificDebugHour) continue; 
      if (slotStartUtc < slightlyFutureServerNowUtc && !isCurrentHourTheSpecificDebugHour) continue; 

      if (!isBusy) { 
        const formattedSlot = new Intl.DateTimeFormat('es-CL', {weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'America/Santiago'}).format(slotStartUtc);
        // =========== CORRECCIÓN CLAVE AQUÍ ===========
        if (targetHourChile !== null) { // Usuario pidió hora específica
            if (hChile === targetHourChile && mChile === targetMinuteChile) { // ¿Es ESTE el slot que pidió?
                availableSlotsOutput.push(formattedSlot); // Añadir SOLO este slot
            }
            // Si no es el slot específico, no se añade nada a availableSlotsOutput,
            // permitiendo que response_builder determine si la hora específica estaba ocupada.
        } else { // Usuario pidió disponibilidad general para el día/franja
            availableSlotsOutput.push(formattedSlot); 
        }
        // ===========================================
      } 
    } // Fin FOR WORKING_HOURS_CHILE_STR
    
    // Lógica de corte del bucle de días
    if (targetDateIdentifierForSlotFilter && getDayIdentifier(currentDayProcessingUtcStart, 'America/Santiago') === targetDateIdentifierForSlotFilter) {
        let specificSlotWasFoundInOutput = false;
        if (targetHourChile !== null) {
            specificSlotWasFoundInOutput = availableSlotsOutput.length > 0; // Si hay algo, es el slot específico
        }
        if (availableSlotsOutput.length >= effectiveConfig.maxSuggestions && !targetHourChile) { break; }
        if (targetHourChile !== null && specificSlotWasFoundInOutput) { break; }
        // Si se pidió hora específica, y ya procesamos el día target, y no se encontró el slot, cortamos.
        if (targetHourChile !== null && i === 0 && !specificSlotWasFoundInOutput ) { break; } 
    }
    if (availableSlotsOutput.length >= effectiveConfig.maxSuggestions && !targetDateIdentifierForSlotFilter && !targetHourChile && processedDaysForGenericQuery.size >=2) { break; } 
  } // Fin FOR i < effectiveConfig.calendarQueryDays
  
  if (targetDateIdentifierForSlotFilter) { console.log(`🔎 Slots generados por slot_availability_calculator para ${requestClientId} el día ${targetDateIdentifierForSlotFilter}: ${availableSlotsOutput.length}`); } 
  else { console.log(`🔎 Slots generados por slot_availability_calculator para ${requestClientId} en búsqueda genérica: ${availableSlotsOutput.length}`); }

  return availableSlotsOutput;
}