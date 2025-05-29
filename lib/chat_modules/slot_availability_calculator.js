// /lib/chat_modules/slot_availability_calculator.js
import { convertChileTimeToUtc, getDayIdentifier } from '@/lib/chat_modules/dateTimeUtils.js';

const WORKING_HOURS_CHILE_STR = [
  '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30',
  '14:00', '14:30', '15:00', '15:30', '16:00', '16:30', '17:00', '17:30',
  '18:00', '18:30', '19:00', '19:30'
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
      console.error(`❌ ERROR (slot_availability_calculator) en calendar.events.list para ${requestClientId}:`, googleError);
      // Propagar el error para que el orquestador lo maneje y pueda desconectar el calendario si es 401
      throw googleError; 
  }
  
  const eventsFromGoogle = googleResponse?.data?.items || [];
  
  const busySlots = eventsFromGoogle.filter(e => e.status !== 'cancelled')
    .map(e => {
      if (e.start?.dateTime && e.end?.dateTime) { // Ignorar eventos all-day
        return { start: new Date(e.start.dateTime).getTime(), end: new Date(e.end.dateTime).getTime() };
      }
      return null;
    }).filter(Boolean);
  
  console.log(`INFO (slot_availability_calculator): Se obtuvieron ${eventsFromGoogle.length} eventos y se procesaron ${busySlots.length} busy slots (ignorando all-day) del calendario para ${requestClientId}.`);
  
  // Log de busySlots solo si NODE_ENV es 'development' y hay busy slots
  if (busySlots.length > 0 && process.env.NODE_ENV === 'development') { 
    console.log(`DEBUG (slot_availability_calculator): Contenido de busySlots (eventos UTC de Google Calendar) para ${requestClientId}:`);
    busySlots.forEach((bs, index) => {
      const eventStartDate = new Date(bs.start);
      const eventEndDate = new Date(bs.end);
      // Comparar con el rango general de la query, no con un slot específico aquí
      if (eventEndDate > new Date(timeMinISO).getTime() && eventStartDate < new Date(timeMaxISO).getTime()) { 
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
    // refDateForTargetCalc, // No se usa directamente aquí si calendarQueryStartUtc ya lo considera
    calendarQueryStartUtc, 
    requestClientId
) {
  const { 
    targetDateForDisplay, 
    targetHourChile, 
    targetMinuteChile, 
    timeOfDay, 
    targetDateIdentifierForSlotFilter, 
    TOMORROW_DATE_IDENTIFIER_CHILE 
  } = queryDetails;

  const availableSlotsOutput = [];
  const processedDaysForGenericQuery = new Set();
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
        console.log(`\n🔍 DEBUGGING "MAÑANA JUEVES 3PM" SLOT PROCESSING (slot_availability_calculator - ClientId: ${requestClientId}):`);
        console.log(`   Current Day (Chile): ${currentDayProcessingIdentifierChile}, Slot Time (Chile) being checked: 15:00`);
        console.log(`   User's Target Hour/Minute (Chile): <span class="math-inline">\{targetHourChile\}\:</span>{targetMinuteChile}`);
    } else if (process.env.NODE_ENV === 'development') { 
        console.log(`\nDEBUG (slot_availability_calculator): Bucle Día i=${i} para ${requestClientId}. Iterando para día UTC: ${currentDayProcessingUtcStart.toISOString()} (Corresponde al día de Chile: ${currentDayProcessingIdentifierChile})`);
        if (targetDateIdentifierForSlotFilter) {
            console.log(`DEBUG (slot_availability_calculator): comparando con targetDateIdentifierForSlotFilter para ${requestClientId}: ${targetDateIdentifierForSlotFilter}`);
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
      const isBusy = busySlots.some(busy => slotStartUtc.getTime() < busy.end && slotEndUtc.getTime