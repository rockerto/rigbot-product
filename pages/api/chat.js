// /pages/api/chat.js (Orquestador SIMPLIFICADO para nueva lógica de widget)

import { getEffectiveConfig, WHATSAPP_FALLBACK_PLACEHOLDER } from '@/lib/chat_modules/config_manager.js';
import { validateRequest } from '@/lib/chat_modules/request_validator.js';
import { getCalendarInstance } from '@/lib/chat_modules/calendar_client_provider.js';
import { CHILE_UTC_OFFSET_HOURS, getDayIdentifier } from '@/lib/chat_modules/dateTimeUtils.js';
import { isCalendarQuery, parseDateTimeQuery } from '@/lib/chat_modules/date_time_parser.js'; 
import { fetchBusySlots, getAvailableSlots } from '@/lib/chat_modules/slot_availability_calculator.js';
import { buildCalendarResponse } from '@/lib/chat_modules/response_builder.js';
import { getOpenAIReply } from '@/lib/chat_modules/openai_handler.js';
import { saveLeadToFirestore, sendLeadNotificationEmail } from '@/lib/chat_modules/lead_manager.js'; 
import { logRigbotMessage } from "@/lib/rigbotLog"; 
import { db } from '@/lib/firebase-admin'; 

const AFFIRMATIVE_LEAD_KEYWORDS = ["sí", "si", "ok", "dale", "bueno", "ya", "porfa", "acepto", "claro", "sipi", "sip"];
const NEGATIVE_LEAD_KEYWORDS = ["no", "no gracias", "ahora no", "después", "quizás más tarde"];


export default async function handler(req, res) {
  const validationResult = await validateRequest(req, res); 
  if (validationResult.handled) {
    return; 
  }

  const clientConfigData = validationResult.clientConfigData || {}; 
  const requestDataFromValidator = validationResult.requestData || {}; 

  console.log("DEBUG_CHAT_ORCHESTRATOR: requestData recibido de validator:", JSON.stringify(requestDataFromValidator, null, 2));
  
  const { 
    message, 
    sessionId: currentSessionId, 
    clientId: requestClientId, 
    ipAddress, 
    sessionState: incomingSessionState, 
    conversationHistory: incomingConversationHistory 
  } = requestDataFromValidator; 

  console.log("DEBUG_CHAT_HANDLER: Full req.body (original):", JSON.stringify(req.body, null, 2)); 

  // Si incomingSessionState es null (primera petición DESPUÉS del saludo del widget), 
  // y lead capture está activado, el widget DEBERÍA haber seteado step a 'offered'.
  // Si no, lo inicializamos de forma segura.
  let sessionState = incomingSessionState || { 
    leadCapture: { 
        step: null, 
        data: { name: "", contactInfo: "", userMessage: "" }, 
        offeredInTurn: null, // Podría ser 0 o 1 si el widget lo seteó
        declinedInSession: false 
    },
    turnCount: 0 
  };
  sessionState.turnCount = (incomingSessionState?.turnCount || 0) + 1; 
  
  // Si el widget indicó que la oferta ya se hizo, y este es el primer mensaje del usuario (turnCount = 1),
  // y el estado de leadCapture aún es null en el backend (no debería pasar si el widget envía 'offered'),
  // forzamos el estado a 'offered'.
  if (sessionState.turnCount === 1 && 
      effectiveConfig.leadCaptureEnabled && // Necesitamos effectiveConfig aquí
      sessionState.leadCapture.step === null &&
      req.body?.initialOfferMadeByWidget === true // Suponiendo que el widget ahora envía esta bandera si él hizo la oferta
      ) {
     // Esto es un fallback, idealmente el widget envía el sessionState con step: 'offered'
     console.warn("DEBUG_CHAT_HANDLER: Widget indicó oferta inicial, pero sessionState.leadCapture.step era null. Forzando a 'offered'.");
     sessionState.leadCapture.step = 'offered';
     sessionState.leadCapture.offeredInTurn = 0; // Turno 0 fue el saludo del widget
  }
  console.log("DEBUG_CHAT_HANDLER: Current sessionState (after potential init/increment):", JSON.stringify(sessionState, null, 2));
  
  let conversationHistory = Array.isArray(incomingConversationHistory) ? incomingConversationHistory : [];
  
  if (typeof logRigbotMessage === "function" && message) { 
    try { 
        console.log(`DEBUG_CHAT_HANDLER: Logging user message to Firestore: "${message}"`);
        await logRigbotMessage({ role: "user", content: message, sessionId: currentSessionId, ip: ipAddress, clientId: requestClientId }); 
    } 
    catch (logErr) { console.error("Error al loguear mensaje de usuario en Firestore (chat.js):", logErr); }
  }
  
  // El widget ya debería estar añadiendo el user message al historial que envía.
  // No necesitamos añadirlo aquí de nuevo si ya está.
  // if (conversationHistory.length === 0 || ...) { ... } -> Eliminado para simplificar
  console.log("DEBUG_CHAT_HANDLER: Current full conversationHistory for processing:", JSON.stringify(conversationHistory, null, 2));
  
  const effectiveConfig = getEffectiveConfig(clientConfigData); 
  console.log("🧠 Configuración efectiva usada (orquestador) para clientId", requestClientId, ":");
  console.log("   leadCaptureEnabled:", effectiveConfig.leadCaptureEnabled);
  console.log("   clinicNameForLeadPrompt:", effectiveConfig.clinicNameForLeadPrompt);
  
  try {
    const lowerMessage = message ? message.toLowerCase() : ""; 
    let botResponseText = ""; 
    let leadCaptureFlowHandled = false; 

    // --- LÓGICA DE CAPTURA DE LEADS (PARTE 1: PROCESAR ESTADO ACTIVO O RESPUESTA A OFERTA) ---
    // Esta lógica ahora es la PRIMERA que se evalúa.
    if (sessionState.leadCapture.step === 'offered') { // Usuario está respondiendo a la oferta inicial del widget
        console.log("DEBUG_CHAT_HANDLER: Handling response to initial lead capture offer.");
        leadCaptureFlowHandled = true; 
        const affirmativeMatch = AFFIRMATIVE_LEAD_KEYWORDS.some(k => lowerMessage.startsWith(k + " ") || lowerMessage === k);
        const negativeMatch = NEGATIVE_LEAD_KEYWORDS.some(k => lowerMessage.startsWith(k + " ") || lowerMessage === k);
        let userNameFromMessage = null;

        if (!affirmativeMatch && !negativeMatch && !isCalendarQuery(lowerMessage) && lowerMessage.length > 1 && lowerMessage.length < 50 && !lowerMessage.includes("?")) { 
            let potentialName = message; 
            const prefixes = ["soy ", "me llamo ", "mi nombre es "];
            for (const prefix of prefixes) {
                if (lowerMessage.startsWith(prefix)) {
                    potentialName = message.substring(prefix.length).trim();
                    break;
                }
            }
            userNameFromMessage = potentialName.split(' ')
                .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
                .join(' ');
            console.log(`DEBUG_CHAT_HANDLER: Posible nombre extraído de la respuesta a la oferta: '${userNameFromMessage}'`);
        }

        if (userNameFromMessage) { 
            sessionState.leadCapture.data.name = userNameFromMessage;
            botResponseText = effectiveConfig.leadCaptureContactPromptTemplate?.replace("{userName}", userNameFromMessage) 
                                || `Gracias, ${userNameFromMessage}. ¿Cuál es tu email o teléfono?`;
            sessionState.leadCapture.step = 'awaiting_contact'; 
        } else if (affirmativeMatch && !negativeMatch) { 
            botResponseText = effectiveConfig.leadCaptureNamePrompt || "¿Cuál es tu nombre?";
            sessionState.leadCapture.step = 'awaiting_name';
        } else if (negativeMatch) { 
            botResponseText = (effectiveConfig.leadCaptureDeclinedMessage || "Entendido. Si cambias de opinión, solo avísame.") + "\n\n¿Cómo puedo ayudarte hoy con tus consultas o horarios?";
            sessionState.leadCapture.step = 'declined_this_session'; 
        } else { // El usuario hizo una pregunta directamente después de la oferta inicial
            console.log("DEBUG (chat.js): Usuario ignoró oferta inicial de lead, se procesará su consulta.");
            sessionState.leadCapture.step = 'postponed_in_session'; // O simplemente null para que no se vuelva a ofrecer inmediatamente
            leadCaptureFlowHandled = false; // Dejar que la consulta se procese normalmente abajo
        }
    } else if (sessionState.leadCapture.step && // Pasos activos como awaiting_name, etc.
        sessionState.leadCapture.step !== 'completed_this_session' && 
        sessionState.leadCapture.step !== 'declined_this_session' &&
        sessionState.leadCapture.step !== 'postponed_in_session' 
    ) {
        console.log(`DEBUG_CHAT_HANDLER: Active lead capture step: ${sessionState.leadCapture.step}`);
        leadCaptureFlowHandled = true;
        // ... (switch para awaiting_name, awaiting_contact, awaiting_message - SIN CAMBIOS)
        switch (sessionState.leadCapture.step) {
            case 'awaiting_name':
                sessionState.leadCapture.data.name = message; 
                botResponseText = effectiveConfig.leadCaptureContactPromptTemplate?.replace("{userName}", message || "tú") 
                                  || `Gracias, ${message || "tú"}. ¿Cuál es tu email o teléfono?`;
                sessionState.leadCapture.step = 'awaiting_contact';
                break;
            case 'awaiting_contact':
                sessionState.leadCapture.data.contactInfo = message; 
                botResponseText = effectiveConfig.leadCaptureMessagePrompt 
                                  || "¿Algo más que quieras añadir (opcional)?";
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
                    await saveLeadToFirestore(requestClientId, leadDataToSave, conversationHistory); 
                    const clinicNameForEmail = effectiveConfig.clinicNameForLeadPrompt || effectiveConfig.name || "la Clínica";
                    const notificationEmail = effectiveConfig.leadNotificationEmail || effectiveConfig.email;
                    if (notificationEmail) {
                        await sendLeadNotificationEmail(notificationEmail, leadDataToSave, conversationHistory, clinicNameForEmail, clientConfigData.name);
                    }
                } catch (leadSaveError) { console.error(`ERROR (chat.js): Fallo al guardar/notificar lead para ${requestClientId}`, leadSaveError); }
                botResponseText = effectiveConfig.leadCaptureConfirmationPromptTemplate
                    ?.replace("{userName}", sessionState.leadCapture.data.name || "tú")
                    .replace("{clinicName}", effectiveConfig.clinicNameForLeadPrompt || effectiveConfig.name || "La clínica") 
                    || `¡Listo, ${sessionState.leadCapture.data.name}! Tus datos fueron guardados. Te contactaremos pronto. ¿En qué más te puedo ayudar?`;
                sessionState.leadCapture.step = 'completed_this_session'; 
                sessionState.leadCapture.data = { name: "", contactInfo: "", userMessage: "" };
                break;
        }
    }
    

    // --- SI NINGÚN FLUJO DE LEAD CAPTURE ACTIVO MANEJÓ LA RESPUESTA ARRIBA ---
    if (!leadCaptureFlowHandled) {
        // Ya no necesitamos una lógica compleja para "ofrecer" aquí,
        // porque la oferta se hace en el saludo inicial del widget.
        // Si el usuario ignoró la oferta (step es 'postponed_in_session') o ya completó/declinó,
        // simplemente procesamos su consulta actual.
        console.log("DEBUG_CHAT_HANDLER: No hay flujo de lead activo, procesando consulta normalmente.");
        if (isCalendarQuery(lowerMessage)) {
            // ... (lógica de calendario como estaba) ...
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
    }
    
    // --- LOGUEO Y RETORNO DE RESPUESTA ---
    // (Esta sección sin cambios)
    if (typeof logRigbotMessage === "function") { 
        try { 
            await logRigbotMessage({ role: "assistant", content: botResponseText, sessionId: currentSessionId, ip: ipAddress, clientId: requestClientId }); 
            if (conversationHistory.length === 0 || conversationHistory[conversationHistory.length -1]?.role !== 'assistant' || conversationHistory[conversationHistory.length -1]?.content !== botResponseText) {
                conversationHistory.push({ role: "assistant", content: botResponseText });
            }
        } 
        catch (e) { console.error("Log Error (respuesta final):", e) } 
    } else {
         if (conversationHistory.length === 0 || conversationHistory[conversationHistory.length -1]?.role !== 'assistant' || conversationHistory[conversationHistory.length -1]?.content !== botResponseText) {
             conversationHistory.push({ role: "assistant", content: botResponseText });
        }
    }
    
    console.log("DEBUG_CHAT_HANDLER: Outgoing sessionState:", JSON.stringify(sessionState, null, 2)); 
    return res.status(200).json({ response: botResponseText, sessionState, conversationHistory });

  } catch (error) {
    console.error(`❌ Error en Rigbot Handler Principal para clientId ${requestClientId}:`, error.message, error.stack);
    const errorForUser = 'Ocurrió un error inesperado en RigBot. Por favor, intenta más tarde.';
    // ... (manejo de error y logueo sin cambios)
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
    const safeSessionStateOnError = sessionState || { leadCapture: { step: null, data: {}, offeredInTurn: null, declinedInSession: false }, turnCount: (sessionState?.turnCount || 0) };
    console.log("DEBUG_CHAT_HANDLER: Outgoing sessionState (on error):", JSON.stringify(safeSessionStateOnError, null, 2)); 
    return res.status(500).json({
      error: errorForUser,
      details: process.env.NODE_ENV === 'development' ? error.message + (error.stack ? `\nStack: ${error.stack.substring(0, 500)}...` : '') : undefined,
      sessionState: safeSessionStateOnError 
    });
  }
}