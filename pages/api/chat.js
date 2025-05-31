// /pages/api/chat.js (Orquestador con Lógica de Captura de Leads y Nuevos Logs)

import { getEffectiveConfig, WHATSAPP_FALLBACK_PLACEHOLDER } from '@/lib/chat_modules/config_manager.js';
import { validateRequest } from '@/lib/chat_modules/request_validator.js';
import { getCalendarInstance } from '@/lib/chat_modules/calendar_client_provider.js';
import { CHILE_UTC_OFFSET_HOURS, getDayIdentifier } from '@/lib/chat_modules/dateTimeUtils.js';
import { isCalendarQuery, parseDateTimeQuery, testFunctionDTP } from '@/lib/chat_modules/date_time_parser.js';
import { fetchBusySlots, getAvailableSlots } from '@/lib/chat_modules/slot_availability_calculator.js';
import { buildCalendarResponse } from '@/lib/chat_modules/response_builder.js';
import { getOpenAIReply } from '@/lib/chat_modules/openai_handler.js';
import { saveLeadToFirestore, sendLeadNotificationEmail } from '@/lib/chat_modules/lead_manager.js';
import { logRigbotMessage } from "@/lib/rigbotLog"; 
import { db } from '@/lib/firebase-admin'; 

const AFFIRMATIVE_LEAD_KEYWORDS = ["sí", "si", "ok", "dale", "bueno", "ya", "porfa", "acepto", "claro"];
const NEGATIVE_LEAD_KEYWORDS = ["no", "no gracias", "ahora no"];


export default async function handler(req, res) {
  const validationResult = await validateRequest(req, res); 
  if (validationResult.handled) {
    return; 
  }

  const clientConfigData = validationResult.clientConfigData || {}; 
  const requestData = validationResult.requestData || {};
  
  // LOG NUEVO: Ver el body completo para asegurar que sessionState y conversationHistory llegan
  console.log("DEBUG_CHAT_HANDLER: Full req.body:", JSON.stringify(req.body, null, 2));

  const { 
    message, 
    sessionId: currentSessionId, 
    clientId: requestClientId, 
    ipAddress, 
    sessionState: incomingSessionState, // Esperamos que el widget lo envíe
    conversationHistory: incomingConversationHistory // Esperamos que el widget lo envíe
  } = requestData;


  let sessionState = incomingSessionState || { 
    leadCapture: { 
        step: null, 
        data: { name: "", contactInfo: "", userMessage: "" }, 
        offeredInTurn: null,
        declinedInSession: false 
    },
    turnCount: 0 
  };
  sessionState.turnCount = (sessionState.turnCount || 0) + 1;
  console.log("DEBUG_CHAT_HANDLER: Incoming/Initialized sessionState:", JSON.stringify(sessionState, null, 2)); // LOG NUEVO

  // Usar el historial de conversación que viene del request, o inicializarlo si no viene.
  const conversationHistory = incomingConversationHistory || [];
  if (conversationHistory.length === 0 && message) { // Si es el primer mensaje real
    conversationHistory.push({role: "user", content: message});
  } else if (conversationHistory.length > 0 && conversationHistory[conversationHistory.length -1].role === 'assistant' && message) {
    // Asegurarse de no duplicar el último mensaje del usuario si ya está en un historial más completo
    conversationHistory.push({role: "user", content: message});
  }


  const effectiveConfig = getEffectiveConfig(clientConfigData); 
  // LOG NUEVO: Mostrar config relevante para lead capture
  console.log("🧠 Configuración efectiva usada (orquestador) para clientId", requestClientId, ":");
  console.log("   leadCaptureEnabled:", effectiveConfig.leadCaptureEnabled);
  console.log("   leadCaptureOfferPromptTemplate:", effectiveConfig.leadCaptureOfferPromptTemplate);
  console.log("   clinicNameForLeadPrompt:", effectiveConfig.clinicNameForLeadPrompt);
  
  try {
    const lowerMessage = message.toLowerCase();
    let botResponseText = "";
    let leadCaptureFlowHandled = false; 

    // --- INICIO LÓGICA DE CAPTURA DE LEADS (PARTE 1: PROCESAR ESTADO ACTUAL) ---
    if (sessionState.leadCapture.step && 
        sessionState.leadCapture.step !== 'offered' && 
        sessionState.leadCapture.step !== 'completed_this_session' && 
        sessionState.leadCapture.step !== 'declined_this_session' &&
        sessionState.leadCapture.step !== 'postponed_in_session' // Añadido para que no entre aquí si pospuso
    ) {
        console.log(`DEBUG_CHAT_HANDLER: Active lead capture step: ${sessionState.leadCapture.step}`);
        leadCaptureFlowHandled = true;
        switch (sessionState.leadCapture.step) {
            case 'awaiting_name':
                sessionState.leadCapture.data.name = message; 
                botResponseText = effectiveConfig.leadCaptureContactPromptTemplate?.replace("{userName}", message || "tú") || `Gracias, ${message || "tú"}. ¿Cuál es tu email o teléfono?`;
                sessionState.leadCapture.step = 'awaiting_contact';
                break;
            case 'awaiting_contact':
                sessionState.leadCapture.data.contactInfo = message; 
                botResponseText = effectiveConfig.leadCaptureMessagePrompt || "¿Algo más que quieras añadir (opcional)?";
                sessionState.leadCapture.step = 'awaiting_message';
                break;
            case 'awaiting_message':
                sessionState.leadCapture.data.userMessage = message; 
                
                const leadDataToSave = {
                    name: sessionState.leadCapture.data.name,
                    contactInfo: sessionState.leadCapture.data.contactInfo,
                    userMessage: sessionState.leadCapture.data.userMessage,
                    sourceWidgetUrl: req.headers.referer || 'No especificado',
                };

                try {
                    // Asegurarse que conversationHistory aquí sea el historial COMPLETO hasta este punto.
                    // El que viene en requestData.conversationHistory es el ideal.
                    await saveLeadToFirestore(requestClientId, leadDataToSave, conversationHistory); 
                    const clinicNameForEmail = effectiveConfig.clinicNameForLeadPrompt || effectiveConfig.name || "la Clínica";
                    const notificationEmail = effectiveConfig.leadNotificationEmail || effectiveConfig.email;
                    if (notificationEmail) {
                        await sendLeadNotificationEmail(notificationEmail, leadDataToSave, conversationHistory, clinicNameForEmail, clientConfigData.name);
                    }
                } catch (leadSaveError) {
                    console.error(`ERROR (chat.js): Fallo al guardar/notificar lead para ${requestClientId}`, leadSaveError);
                }
                
                botResponseText = effectiveConfig.leadCaptureConfirmationPromptTemplate
                    ?.replace("{userName}", sessionState.leadCapture.data.name || "tú")
                    .replace("{clinicName}", effectiveConfig.clinicNameForLeadPrompt || effectiveConfig.name || "La clínica") 
                    || `¡Listo, ${sessionState.leadCapture.data.name}! Tus datos fueron guardados. Te contactaremos pronto. ¿En qué más te puedo ayudar?`;
                
                sessionState.leadCapture.step = 'completed_this_session'; 
                sessionState.leadCapture.data = { name: "", contactInfo: "", userMessage: "" };
                break;
        }
    } else if (sessionState.leadCapture.step === 'offered') {
        console.log("DEBUG_CHAT_HANDLER: Handling response to lead capture offer.");
        leadCaptureFlowHandled = true; 
        const affirmativeMatch = AFFIRMATIVE_LEAD_KEYWORDS.some(k => lowerMessage.includes(k));
        const negativeMatch = NEGATIVE_LEAD_KEYWORDS.some(k => lowerMessage.includes(k));

        if (affirmativeMatch && !negativeMatch) { 
            botResponseText = effectiveConfig.leadCaptureNamePrompt || "¿Cuál es tu nombre?";
            sessionState.leadCapture.step = 'awaiting_name';
        } else if (negativeMatch) { 
            botResponseText = effectiveConfig.leadCaptureDeclinedMessage || "Entendido. Si cambias de opinión, solo avísame. ¿Cómo puedo ayudarte hoy con tus consultas o horarios?";
            sessionState.leadCapture.step = 'declined_this_session'; 
        } else { 
            console.log("DEBUG (chat.js): Usuario ignoró oferta de lead, procede con su consulta.");
            sessionState.leadCapture.step = 'postponed_in_session'; 
            leadCaptureFlowHandled = false; 
        }
    }
    // --- FIN LÓGICA DE CAPTURA DE LEADS (PARTE 1) ---

    if (!leadCaptureFlowHandled) { 
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
                    }
                    
                    if (busySlots) { 
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
                    } else if (!botResponseText) { 
                        botResponseText = "Hubo un problema obteniendo la disponibilidad del calendario.";
                    }
                }
            }
        } else { 
          botResponseText = await getOpenAIReply(message, effectiveConfig, requestClientId);
        }

        // --- INICIO LÓGICA DE CAPTURA DE LEADS (PARTE 2: OFRECER SI APLICA) ---
        console.log("DEBUG_CHAT_HANDLER: Verificando si ofrecer lead capture. Current sessionState.leadCapture:", JSON.stringify(sessionState.leadCapture, null, 2), "Turn:", sessionState.turnCount); // LOG NUEVO
        
        if (effectiveConfig.leadCaptureEnabled && 
            (sessionState.leadCapture.step === null || sessionState.leadCapture.step === 'postponed_in_session') && // Ofrecer si no hay un flujo activo o si se pospuso
            !sessionState.leadCapture.declinedInSession && 
            sessionState.turnCount <= 2 // Condición de ejemplo: ofrecer solo en los primeros 2 turnos si no se ha declinado antes
        ) {
            const offerPrompt = effectiveConfig.leadCaptureOfferPromptTemplate?.replace("{clinicName}", effectiveConfig.clinicNameForLeadPrompt || effectiveConfig.name || "la clínica") 
                                || `Si lo deseas, puedo tomar tus datos de contacto (nombre y email/teléfono) para que ${effectiveConfig.clinicNameForLeadPrompt || effectiveConfig.name || "la clínica"} se comunique contigo. ¿Te gustaría?`;
            
            botResponseText += `\n\n${offerPrompt}`; 
            sessionState.leadCapture.step = 'offered';
            sessionState.leadCapture.offeredInTurn = sessionState.turnCount;
            console.log(`DEBUG_CHAT_HANDLER: Ofreciendo captura de lead en turno ${sessionState.turnCount}`); // LOG NUEVO
        }
        // --- FIN LÓGICA DE CAPTURA DE LEADS (PARTE 2) ---
    }

    if (typeof logRigbotMessage === "function") { 
        try { await logRigbotMessage({ role: "assistant", content: botResponseText, sessionId: currentSessionId, ip: ipAddress, clientId: requestClientId }); } 
        catch (e) { console.error("Log Error (respuesta final):", e) } 
    }
    
    console.log("DEBUG_CHAT_HANDLER: Outgoing sessionState:", JSON.stringify(sessionState, null, 2)); // LOG NUEVO
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
    console.log("DEBUG_CHAT_HANDLER: Outgoing sessionState (on error):", JSON.stringify(sessionState, null, 2)); // LOG NUEVO
    return res.status(500).json({
      error: errorForUser,
      details: process.env.NODE_ENV === 'development' ? error.message + (error.stack ? `\nStack: ${error.stack.substring(0, 500)}...` : '') : undefined,
      sessionState 
    });
  }
}