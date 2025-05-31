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
  
  // === INICIO DE CAMBIO EN EXTRACCIÓN Y LOGS ===
  const { 
    message, 
    sessionId: currentSessionId, 
    clientId: requestClientId, 
    ipAddress, 
    // sessionState y conversationHistory ahora vienen de requestData gracias a request_validator.js
    sessionState: incomingSessionStateFromValidator, 
    conversationHistory: incomingConversationHistoryFromValidator 
  } = requestData;

  console.log("DEBUG_CHAT_HANDLER: Full requestData from validator:", JSON.stringify(requestData, null, 2));
  // === FIN DE CAMBIO EN EXTRACCIÓN ===

  let sessionState = incomingSessionStateFromValidator || { 
    leadCapture: { 
        step: null, 
        data: { name: "", contactInfo: "", userMessage: "" }, 
        offeredInTurn: null,
        declinedInSession: false 
    },
    turnCount: 0 
  };
  // Incrementar turnCount basado en el estado actual o inicializarlo
  sessionState.turnCount = sessionState.turnCount + 1; // Ya no necesita el ( ... || 0) porque siempre estará inicializado

  console.log("DEBUG_CHAT_HANDLER: Current sessionState (after potential init/increment):", JSON.stringify(sessionState, null, 2));

  // === INICIO DE CAMBIO EN MANEJO DE CONVERSATION HISTORY ===
  // Usar el historial de conversación que viene del requestData (ya parseado por request_validator)
  // o inicializarlo si no viene (aunque request_validator debería manejarlo).
  const conversationHistory = Array.isArray(incomingConversationHistoryFromValidator) ? incomingConversationHistoryFromValidator : [];
  
  // El logRigbotMessage del mensaje del USUARIO ahora se hace aquí, después de toda validación inicial
  // y antes de cualquier procesamiento de lógica de chat.
  if (typeof logRigbotMessage === "function") { 
    try { 
        console.log(`DEBUG_CHAT_HANDLER: Logging user message to Firestore: "${message}"`);
        await logRigbotMessage({ role: "user", content: message, sessionId: currentSessionId, ip: ipAddress, clientId: requestClientId }); 
    } 
    catch (logErr) { console.error("Error al loguear mensaje de usuario en Firestore (chat.js):", logErr); }
  }
  // Y el historial que se usa para lógica interna y se pasa a otros módulos
  // ya debería tener el mensaje del usuario actual si el widget lo añadió correctamente.
  // Si no, lo añadimos aquí para consistencia interna.
  if (conversationHistory.length === 0 || conversationHistory[conversationHistory.length -1].role !== 'user' || conversationHistory[conversationHistory.length -1].content !== message) {
      if(conversationHistory.length > 0 && conversationHistory[conversationHistory.length -1].role === 'user' && conversationHistory[conversationHistory.length -1].content === message){
          // Ya está, no hacer nada.
      } else {
          console.log("DEBUG_CHAT_HANDLER: User message not found or last in history, adding to internal conversationHistory.");
          conversationHistory.push({role: "user", content: message});
      }
  }
  console.log("DEBUG_CHAT_HANDLER: Current full conversationHistory for processing:", JSON.stringify(conversationHistory, null, 2));
  // === FIN DE CAMBIO EN MANEJO DE CONVERSATION HISTORY ===


  const effectiveConfig = getEffectiveConfig(clientConfigData); 
  console.log("🧠 Configuración efectiva usada (orquestador) para clientId", requestClientId, ":");
  console.log("   leadCaptureEnabled:", effectiveConfig.leadCaptureEnabled);
  console.log("   leadCaptureOfferPromptTemplate:", effectiveConfig.leadCaptureOfferPromptTemplate); // Puede ser largo
  console.log("   clinicNameForLeadPrompt:", effectiveConfig.clinicNameForLeadPrompt);
  
  try {
    const lowerMessage = message.toLowerCase();
    let botResponseText = "";
    let leadCaptureFlowHandled = false; 

    if (sessionState.leadCapture.step && 
        sessionState.leadCapture.step !== 'offered' && 
        sessionState.leadCapture.step !== 'completed_this_session' && 
        sessionState.leadCapture.step !== 'declined_this_session' &&
        sessionState.leadCapture.step !== 'postponed_in_session' 
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
                    // Pasar el 'conversationHistory' actual que incluye el último mensaje del lead
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

    if (!leadCaptureFlowHandled) { 
        // ... (resto de la lógica de isCalendarQuery, parseDateTimeQuery, etc. SIN CAMBIOS) ...
        // ... (hasta el final del bloque if/else de OpenAI) ...
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

        // --- LÓGICA DE OFERTA DE LEAD CAPTURE ---
        console.log("DEBUG_CHAT_HANDLER: Verificando si ofrecer lead capture. Current sessionState.leadCapture:", JSON.stringify(sessionState.leadCapture, null, 2), "Turn:", sessionState.turnCount);
        
        if (effectiveConfig.leadCaptureEnabled && 
            (sessionState.leadCapture.step === null || sessionState.leadCapture.step === 'postponed_in_session') &&
            !sessionState.leadCapture.declinedInSession && 
            sessionState.turnCount <= 2 
        ) {
            const offerPrompt = effectiveConfig.leadCaptureOfferPromptTemplate?.replace("{clinicName}", effectiveConfig.clinicNameForLeadPrompt || effectiveConfig.name || "la clínica") 
                                || `Si lo deseas, puedo tomar tus datos de contacto (nombre y email/teléfono) para que ${effectiveConfig.clinicNameForLeadPrompt || effectiveConfig.name || "la clínica"} se comunique contigo. ¿Te gustaría?`;
            
            botResponseText += `\n\n${offerPrompt}`; 
            sessionState.leadCapture.step = 'offered';
            sessionState.leadCapture.offeredInTurn = sessionState.turnCount;
            console.log(`DEBUG_CHAT_HANDLER: Ofreciendo captura de lead en turno ${sessionState.turnCount}`);
        }
    }

    if (typeof logRigbotMessage === "function") { 
        try { 
            // Loguear la respuesta final del bot ANTES de añadirla al historial que se devuelve al widget
            await logRigbotMessage({ role: "assistant", content: botResponseText, sessionId: currentSessionId, ip: ipAddress, clientId: requestClientId }); 
            // Añadir la respuesta del bot al historial que se devuelve para el siguiente turno
            conversationHistory.push({ role: "assistant", content: botResponseText });
        } 
        catch (e) { console.error("Log Error (respuesta final):", e) } 
    } else {
        // Si no hay logRigbotMessage, igual añadir al historial para el widget
        conversationHistory.push({ role: "assistant", content: botResponseText });
    }
    
    console.log("DEBUG_CHAT_HANDLER: Outgoing sessionState:", JSON.stringify(sessionState, null, 2)); 
    // Devolver el historial de conversación actualizado y el estado de sesión
    return res.status(200).json({ response: botResponseText, sessionState, conversationHistory });

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
    console.log("DEBUG_CHAT_HANDLER: Outgoing sessionState (on error):", JSON.stringify(sessionState, null, 2)); 
    return res.status(500).json({
      error: errorForUser,
      details: process.env.NODE_ENV === 'development' ? error.message + (error.stack ? `\nStack: ${error.stack.substring(0, 500)}...` : '') : undefined,
      sessionState 
    });
  }
}