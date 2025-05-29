// /pages/api/chat.js
import { getEffectiveConfig, WHATSAPP_FALLBACK_PLACEHOLDER } from '@/lib/chat_modules/config_manager.js';
import { validateRequest } from '@/lib/chat_modules/request_validator.js';
import { getCalendarInstance } from '@/lib/chat_modules/calendar_client_provider.js';
import { CHILE_UTC_OFFSET_HOURS, getDayIdentifier } from '@/lib/chat_modules/dateTimeUtils.js';
import { isCalendarQuery, parseDateTimeQuery } from '@/lib/chat_modules/date_time_parser.js';
import { fetchBusySlots, getAvailableSlots } from '@/lib/chat_modules/slot_availability_calculator.js';
import { buildCalendarResponse } from '@/lib/chat_modules/response_builder.js';
import { getOpenAIReply } from '@/lib/chat_modules/openai_handler.js';
import { logRigbotMessage } from "@/lib/rigbotLog.js";
import { db } from '@/lib/firebase-admin.js'; // db es usado por calendar_client_provider

export default async function handler(req, res) {
  const validationResult = await validateRequest(req, res); // logRigbotMessage ya se llama dentro para user message
  if (validationResult.handled) {
    return; 
  }

  const { clientConfigData, requestData } = validationResult;
  const { message, sessionId: currentSessionId, clientId: requestClientId, ipAddress } = requestData;

  const effectiveConfig = getEffectiveConfig(clientConfigData);
  console.log("🧠 Configuración efectiva usada (orquestador) para clientId", requestClientId, ":", JSON.stringify(effectiveConfig, null, 2).substring(0, 300) + "...");


  try {
    const lowerMessage = message.toLowerCase();

    if (isCalendarQuery(lowerMessage)) {
      const serverNowUtc = new Date();
      const currentYearChile = parseInt(new Intl.DateTimeFormat('en-US', { year: 'numeric', timeZone: 'America/Santiago' }).format(serverNowUtc), 10);
      //const currentMonthChile = parseInt(new Intl.DateTimeFormat('en-US', { month: 'numeric', timeZone: 'America/Santiago' }).format(serverNowUtc), 10) -1;
      //const currentDayOfMonthChile = parseInt(new Intl.DateTimeFormat('en-US', { day: 'numeric', timeZone: 'America/Santiago' }).format(serverNowUtc), 10);
      //const todayChile0000UtcTimestamp = Date.UTC(currentYearChile, currentMonthChile, currentDayOfMonthChile, 0 - CHILE_UTC_OFFSET_HOURS, 0, 0, 0);
      // refDateForTargetCalc se crea dentro de parseDateTimeQuery ahora, pero necesitamos CHILE_UTC_OFFSET_HOURS y las funciones de fecha
      
      // Inicializar refDateForTargetCalc aquí para que esté disponible globalmente en este handler si es necesario
      const currentMonthForRef = parseInt(new Intl.DateTimeFormat('en-US', { month: 'numeric', timeZone: 'America/Santiago' }).format(serverNowUtc), 10) -1;
      const currentDayForRef = parseInt(new Intl.DateTimeFormat('en-US', { day: 'numeric', timeZone: 'America/Santiago' }).format(serverNowUtc), 10);
      const refDateTimestamp = Date.UTC(currentYearChile, currentMonthForRef, currentDayForRef, 0 - CHILE_UTC_OFFSET_HOURS, 0, 0, 0);
      const refDateForTargetCalc = new Date(refDateTimestamp);


      const queryDetails = parseDateTimeQuery(lowerMessage, effectiveConfig, serverNowUtc, refDateForTargetCalc, requestClientId);

      if (queryDetails.earlyResponse) { // Manejar respuestas tempranas de parseDateTimeQuery (fecha lejana, fuera de horario)
        if (typeof logRigbotMessage === "function") { try { await logRigbotMessage({ role: "assistant", content: queryDetails.earlyResponse.response, sessionId: currentSessionId, ip: ipAddress, clientId: requestClientId }); } catch (e) { console.error("Log Error (earlyResponse):", e) } }
        return res.status(queryDetails.earlyResponse.status).json({ response: queryDetails.earlyResponse.response });
      }
      
      const calendar = await getCalendarInstance(requestClientId, clientConfigData); 
      if (!calendar) {
        const errorMsg = "Lo siento, estoy teniendo problemas para conectar con el servicio de calendario en este momento.";
        if (typeof logRigbotMessage === "function") { try { await logRigbotMessage({ role: "assistant", content: errorMsg, sessionId: currentSessionId, ip: ipAddress, clientId: requestClientId }); } catch(e){console.error("Log Error (calendar instance):",e)} }
        return res.status(503).json({ response: errorMsg });
      }

      let calendarQueryStartUtc;
      if (queryDetails.targetDateForDisplay) { calendarQueryStartUtc = new Date(queryDetails.targetDateForDisplay.getTime());} 
      else { calendarQueryStartUtc = new Date(refDateForTargetCalc.getTime()); } 
      
      if (!queryDetails.targetDateForDisplay && calendarQueryStartUtc < serverNowUtc && 
          getDayIdentifier(calendarQueryStartUtc, 'America/Santiago') === getDayIdentifier(serverNowUtc, 'America/Santiago')) {
            const tempTomorrow = new Date(refDateForTargetCalc);
            tempTomorrow.setUTCDate(tempTomorrow.getUTCDate() + 1);
            if (calendarQueryStartUtc < serverNowUtc ) { 
                 const currentLocalHour = parseInt(new Intl.DateTimeFormat('en-US', {hour:'2-digit', hour12: false, timeZone:'America/Santiago'}).format(serverNowUtc));
                 if (currentLocalHour >= 19) { 
                    console.log("DEBUG (orquestador): Query genérica para hoy pero es tarde, iniciando búsqueda desde mañana.")
                    calendarQueryStartUtc = tempTomorrow;
                 }
            }
      }
      const calendarQueryEndUtc = new Date(calendarQueryStartUtc);
      calendarQueryEndUtc.setUTCDate(calendarQueryStartUtc.getUTCDate() + effectiveConfig.calendarQueryDays);

      let busySlots;
      try {
          busySlots = await fetchBusySlots(calendar, calendarQueryStartUtc.toISOString(), calendarQueryEndUtc.toISOString(), requestClientId);
      } catch (googleError) {
          console.error(`❌ ERROR en fetchBusySlots (orquestador) para ${requestClientId}:`, googleError);
          // Si es un error de autenticación con el token del usuario, el provider ya lo manejó (desconectó).
          // Aquí solo devolvemos un error genérico al usuario.
          const errorResponsePayload = { error: 'Error al consultar el calendario de Google.', details: googleError.message };
          if (typeof logRigbotMessage === "function") { try { await logRigbotMessage({ role: "assistant", content: `Error interno calendario: ${errorResponsePayload.error} Detalles: ${errorResponsePayload.details}`, sessionId: currentSessionId, ip: ipAddress, clientId: requestClientId });} catch(e){console.error("Log Error (fetchBusySlots catch):",e)} }
          return res.status(500).json(errorResponsePayload);
      }
      
      const availableSlotsOutput = getAvailableSlots(
          busySlots, 
          queryDetails, 
          effectiveConfig, 
          serverNowUtc, 
          refDateForTargetCalc, // Pasando refDateForTargetCalc
          calendarQueryStartUtc, 
          requestClientId
      );
      
      const replyCalendar = buildCalendarResponse(
          availableSlotsOutput, 
          queryDetails, 
          effectiveConfig, 
          serverNowUtc, 
          refDateForTargetCalc,
          busySlots, 
          currentYearChile, 
          requestClientId
      );

      if (typeof logRigbotMessage === "function") { try { await logRigbotMessage({ role: "assistant", content: replyCalendar, sessionId: currentSessionId, ip: ipAddress, clientId: requestClientId }); } catch (e) { console.error("Log Error (calendar reply):", e) } }
      return res.status(200).json({ response: replyCalendar });

    } else { // No es consulta de calendario
      const gptReply = await getOpenAIReply(message, effectiveConfig, requestClientId);
      if (typeof logRigbotMessage === "function") { try { await logRigbotMessage({ role: "assistant", content: gptReply, sessionId: currentSessionId, ip: ipAddress, clientId: requestClientId }); } catch (e) { console.error("Log Error (OpenAI reply):", e) } }
      return res.status(200).json({ response: gptReply });
    }

  } catch (error) {
    console.error(`❌ Error en Rigbot Handler Principal para clientId ${requestClientId}:`, error.message, error.stack);
    const errorForUser = 'Ocurrió un error inesperado en Rigbot. Por favor, intenta más tarde.';
    if (typeof logRigbotMessage === "function") {
      try {
        await logRigbotMessage({
          role: "assistant",
          content: `Error interno Gral: ${error.message}. UserMsg: ${errorForUser}`,
          sessionId: currentSessionId,
          ip: ipAddress,
          clientId: requestClientId
        });
      } catch (eLogging) {
        console.error("Error al loguear el error final en handler principal:", eLogging);
      }
    }
    return res.status(500).json({
      error: errorForUser,
      details: process.env.NODE_ENV === 'development' ? error.message + (error.stack ? `\nStack: ${error.stack.substring(0, 500)}...` : '') : undefined
    });
  }
}