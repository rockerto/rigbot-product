// /pages/api/chat.js (Orquestador con Lógica de Captura de Leads)

import { getEffectiveConfig, WHATSAPP_FALLBACK_PLACEHOLDER } from '@/lib/chat_modules/config_manager.js';
import { validateRequest } from '@/lib/chat_modules/request_validator.js';
import { getCalendarInstance } from '@/lib/chat_modules/calendar_client_provider.js';
import { CHILE_UTC_OFFSET_HOURS, getDayIdentifier } from '@/lib/chat_modules/dateTimeUtils.js';
import { isCalendarQuery, parseDateTimeQuery, testFunctionDTP } from '@/lib/chat_modules/date_time_parser.js';
import { fetchBusySlots, getAvailableSlots } from '@/lib/chat_modules/slot_availability_calculator.js';
import { buildCalendarResponse } from '@/lib/chat_modules/response_builder.js';
import { getOpenAIReply } from '@/lib/chat_modules/openai_handler.js';
import { saveLeadToFirestore, sendLeadNotificationEmail } from '@/lib/chat_modules/lead_manager.js'; // NUEVO IMPORT
import { logRigbotMessage } from "@/lib/rigbotLog"; 
import { db } from '@/lib/firebase-admin'; 

// Palabras clave afirmativas para captura de leads
const AFFIRMATIVE_LEAD_KEYWORDS = ["sí", "si", "ok", "dale", "bueno", "ya", "porfa", "acepto", "claro"];
const NEGATIVE_LEAD_KEYWORDS = ["no", "no gracias", "ahora no"];


export default async function handler(req, res) {
  const validationResult = await validateRequest(req, res); 
  if (validationResult.handled) {
    return; 
  }

  const clientConfigData = validationResult.clientConfigData || {}; 
  const requestData = validationResult.requestData || {};
  // Extraer sessionState del requestData; si no viene, inicializarlo.
  const { message, sessionId: currentSessionId, clientId: requestClientId, ipAddress, sessionState: incomingSessionState } = requestData;

  let sessionState = incomingSessionState || { 
    leadCapture: { 
        step: null, 
        data: { name: "", contactInfo: "", userMessage: "" }, 
        offeredInTurn: null,
        declinedInSession: false // Para no volver a ofrecer si ya dijo que no explícitamente
    },
    turnCount: 0 
  };
  sessionState.turnCount = (sessionState.turnCount || 0) + 1;

  const effectiveConfig = getEffectiveConfig(clientConfigData); 
  console.log("🧠 Configuración efectiva usada (orquestador) para clientId", requestClientId, ":", JSON.stringify(effectiveConfig, null, 2).substring(0, 300) + "...");
  
  // Log de la función de prueba de date_time_parser (si aún es necesario)
  // const testResult = testFunctionDTP(); 
  // console.log("DEBUG_ORCHESTRATOR: testFunctionDTP result:", testResult); 

  try {
    const lowerMessage = message.toLowerCase();
    let botResponseText = "";
    let leadCaptureFlowHandled = false; // Flag para saber si el flujo de lead capture ya dio una respuesta

    // --- INICIO LÓGICA DE CAPTURA DE LEADS ---

    // 1. Procesar si estamos EN MEDIO de una captura de leads
    if (sessionState.leadCapture.step && sessionState.leadCapture.step !== 'offered' && sessionState.leadCapture.step !== 'completed_this_session' && sessionState.leadCapture.step !== 'declined_this_session') {
        leadCaptureFlowHandled = true;
        switch (sessionState.leadCapture.step) {
            case 'awaiting_name':
                sessionState.leadCapture.data.name = message; // Guardar el nombre
                botResponseText = effectiveConfig.leadCaptureContactPromptTemplate?.replace("{userName}", message) || `Gracias, ${message}. ¿Cuál es tu email o teléfono?`;
                sessionState.leadCapture.step = 'awaiting_contact';
                break;
            case 'awaiting_contact':
                sessionState.leadCapture.data.contactInfo = message; // Guardar info de contacto
                botResponseText = effectiveConfig.leadCaptureMessagePrompt || "¿Algo más que quieras añadir (opcional)?";
                sessionState.leadCapture.step = 'awaiting_message';
                break;
            case 'awaiting_message':
                sessionState.leadCapture.data.userMessage = message; // Guardar mensaje adicional
                
                const leadDataToSave = {
                    name: sessionState.leadCapture.data.name,
                    contactInfo: sessionState.leadCapture.data.contactInfo,
                    userMessage: sessionState.leadCapture.data.userMessage,
                    sourceWidgetUrl: req.headers.referer || 'No especificado', // URL de la página del widget
                };

                try {
                    await saveLeadToFirestore(requestClientId, leadDataToSave, requestData.conversationHistory); // conversationHistory viene de requestData
                    const clinicNameForEmail = effectiveConfig.clinicNameForLeadPrompt || effectiveConfig.name || "la Clínica";
                    const notificationEmail = effectiveConfig.leadNotificationEmail || effectiveConfig.email;
                    if (notificationEmail) {
                        await sendLeadNotificationEmail(notificationEmail, leadDataToSave, requestData.conversationHistory, clinicNameForEmail, clientConfigData.name);
                    }
                } catch (leadSaveError) {
                    console.error(`ERROR (chat.js): Fallo al guardar/notificar lead para ${requestClientId}`, leadSaveError);
                    // No fallar la respuesta al usuario, pero loguear el error.
                }
                
                botResponseText = effectiveConfig.leadCaptureConfirmationPromptTemplate
                    ?.replace("{userName}", sessionState.leadCapture.data.name || "tú")
                    .replace("{clinicName}", effectiveConfig.clinicNameForLeadPrompt || effectiveConfig.name || "La clínica") 
                    || `¡Listo, ${sessionState.leadCapture.data.name}! Tus datos fueron guardados. Te contactaremos pronto. ¿En qué más te puedo ayudar?`;
                
                // Resetear el estado de captura de leads
                sessionState.leadCapture.step = 'completed_this_session'; // Marcar como completado para no volver a ofrecer en esta sesión
                sessionState.leadCapture.data = { name: "", contactInfo: "", userMessage: "" };
                break;
        }
    }
    // 2. Procesar si ACABAMOS de ofrecer la captura de leads
    else if (sessionState.leadCapture.step === 'offered') {
        leadCaptureFlowHandled = true; // Asumimos que manejaremos la respuesta aquí
        const affirmativeMatch = AFFIRMATIVE_LEAD_KEYWORDS.some(k => lowerMessage.includes(k));
        const negativeMatch = NEGATIVE_LEAD_KEYWORDS.some(k => lowerMessage.includes(k));

        if (affirmativeMatch && !negativeMatch) { // "sí", "dale", "ya", etc. y no contiene "no"
            botResponseText = effectiveConfig.leadCaptureNamePrompt || "¿Cuál es tu nombre?";
            sessionState.leadCapture.step = 'awaiting_name';
        } else if (negativeMatch) { // "no", "no gracias"
            botResponseText = effectiveConfig.leadCaptureDeclinedMessage || "Entendido. Si cambias de opinión, solo avísame. ¿Cómo puedo ayudarte hoy con tus consultas o horarios?";
            sessionState.leadCapture.step = 'declined_this_session'; // Para no volver a ofrecer
        } else { // El usuario hizo otra pregunta, ignorando la oferta de leads
            const fallbackDecline = effectiveConfig.leadCaptureDeclinedMessage || "Entendido. Si cambias de opinión, solo avísame. ";
            console.log("DEBUG (chat.js): Usuario ignoró oferta de lead, procede con su consulta.");
            sessionState.leadCapture.step = 'postponed_in_session'; // Lo pospuso, no ofrecer inmediatamente
            leadCaptureFlowHandled = false; // Dejar que el flujo normal procese la pregunta
            // Podríamos añadir el fallbackDecline a la respuesta normal si queremos ser explícitos.
            // Por ahora, simplemente responderemos la pregunta (Opción B1 de Roberto).
        }
    }

    // --- FIN LÓGICA DE CAPTURA DE LEADS (PARTE 1: PROCESAR ESTADO ACTUAL) ---

    if (!leadCaptureFlowHandled) { // Si no estábamos en medio de una captura o respondiendo a la oferta
        if (isCalendarQuery(lowerMessage)) {
            const serverNowUtc = new Date();
            const currentYearChile = parseInt(new Intl.DateTimeFormat('en-US', { year: 'numeric', timeZone: 'America/Santiago' }).format(serverNowUtc), 10);
            const currentMonthForRef = parseInt(new Intl.DateTimeFormat('en-US', { month: 'numeric', timeZone: 'America/Santiago' }).format(serverNowUtc), 10) -1;
            const currentDayForRef = parseInt(new Intl.DateTimeFormat('en-US', { day: 'numeric', timeZone: 'America/Santiago' }).format(serverNowUtc), 10);
            const refDateTimestamp = Date.UTC(currentYearChile, currentMonthForRef, currentDayForRef, 0 - CHILE_UTC_OFFSET_HOURS, 0, 0, 0);
            const refDateForTargetCalc = new Date(refDateTimestamp);

            const queryDetails = parseDateTimeQuery(lowerMessage, effectiveConfig, serverNowUtc, refDateForTargetCalc, requestClientId);

            if (queryDetails.earlyResponse) { 
                botResponseText = queryDetails.earlyResponse.response;
                // No añadir oferta de lead si la respuesta ya es un "corte" (ej. fecha lejana)
            } else {
                const calendar = await getCalendarInstance(requestClientId, clientConfigData); 
                if (!calendar) {
                    botResponseText = "Lo siento, estoy teniendo problemas para conectar con el servicio de calendario en este momento.";
                } else {
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
                        console.error(`❌ ERROR en fetchBusySlots (orquestador) para ${requestClientId}:`, googleError.message);
                        botResponseText = 'Error al consultar el calendario de Google.';
                        // Aquí no hacemos return, para que pueda ofrecer captura de lead si aplica
                    }
                    
                    if (busySlots) { // Solo si fetchBusySlots fue exitoso
                        const availableSlotsOutput = getAvailableSlots(
                            busySlots, queryDetails, effectiveConfig, 
                            serverNowUtc, refDateForTargetCalc, 
                            calendarQueryStartUtc, requestClientId
                        );
                        botResponseText = buildCalendarResponse(
                            availableSlotsOutput, queryDetails, effectiveConfig, 
                            serverNowUtc, refDateForTargetCalc, busySlots, 
                            currentYearChile, requestClientId
                        );
                    } else if (!botResponseText) { // Si busySlots es undefined y no hay otro error seteado
                        botResponseText = "Hubo un problema obteniendo la disponibilidad del calendario.";
                    }
                }
            }
        } else { // No es consulta de calendario
          botResponseText = await getOpenAIReply(message, effectiveConfig, requestClientId);
        }

        // --- INICIO LÓGICA DE CAPTURA DE LEADS (PARTE 2: OFRECER SI APLICA) ---
        if (effectiveConfig.leadCaptureEnabled && 
            sessionState.leadCapture.step === null && // No estamos ya en un flujo de captura
            !sessionState.leadCapture.declinedInSession && // No ha declinado explícitamente en esta sesión
            sessionState.turnCount <= 2 // Ofrecer solo en los primeros 2 turnos, por ejemplo
        ) {
            const offerPrompt = effectiveConfig.leadCaptureOfferPromptTemplate?.replace("{clinicName}", effectiveConfig.clinicNameForLeadPrompt || effectiveConfig.name || "la clínica") 
                                || `Si lo deseas, puedo tomar tus datos de contacto (nombre y email/teléfono) para que ${effectiveConfig.clinicNameForLeadPrompt || effectiveConfig.name || "la clínica"} se comunique contigo. ¿Te gustaría?`;
            
            botResponseText += `\n\n${offerPrompt}`; // Añadir al final de la respuesta normal
            sessionState.leadCapture.step = 'offered';
            sessionState.leadCapture.offeredInTurn = sessionState.turnCount;
            console.log(`DEBUG (chat.js): Ofreciendo captura de lead en turno ${sessionState.turnCount}`);
        }
        // --- FIN LÓGICA DE CAPTURA DE LEADS (PARTE 2) ---
    }

    if (typeof logRigbotMessage === "function") { 
        try { await logRigbotMessage({ role: "assistant", content: botResponseText, sessionId: currentSessionId, ip: ipAddress, clientId: requestClientId }); } 
        catch (e) { console.error("Log Error (respuesta final):", e) } 
    }
    // Devolver siempre el sessionState actualizado al frontend
    return res.status(200).json({ response: botResponseText, sessionState });

  } catch (error) {
    console.error(`❌ Error en Rigbot Handler Principal para clientId ${requestClientId}:`, error.message, error.stack);
    const errorForUser = 'Ocurrió un error inesperado en RigBot. Por favor, intenta más tarde.';
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
    // Devolver sessionState incluso en error, para que el frontend pueda mantener la cuenta de turnos, etc.
    return res.status(500).json({
      error: errorForUser,
      details: process.env.NODE_ENV === 'development' ? error.message + (error.stack ? `\nStack: ${error.stack.substring(0, 500)}...` : '') : undefined,
      sessionState 
    });
  }
}