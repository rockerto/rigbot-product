// /pages/api/chat.js (Inicialización de sessionState más explícita)

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

  // ======== INICIO DE CORRECCIÓN EN INICIALIZACIÓN DE sessionState ========
  let currentTurnCount = 0;
  let leadCaptureStep = null;
  let leadCaptureData = { name: "", contactInfo: "", userMessage: "" };
  let leadCaptureOfferedInTurn = null;
  let leadCaptureDeclinedInSession = false;

  if (incomingSessionState && typeof incomingSessionState === 'object') {
      console.log("DEBUG_CHAT_HANDLER: Usando incomingSessionState.");
      currentTurnCount = typeof incomingSessionState.turnCount === 'number' ? incomingSessionState.turnCount : 0;
      if (incomingSessionState.leadCapture && typeof incomingSessionState.leadCapture === 'object') {
          leadCaptureStep = incomingSessionState.leadCapture.step || null;
          // Asegurar que data sea un objeto incluso si viene null/undefined de alguna forma
          leadCaptureData = (incomingSessionState.leadCapture.data && typeof incomingSessionState.leadCapture.data === 'object') 
                            ? incomingSessionState.leadCapture.data 
                            : { name: "", contactInfo: "", userMessage: "" };
          // Asegurar que los campos dentro de data existan
          leadCaptureData.name = leadCaptureData.name || "";
          leadCaptureData.contactInfo = leadCaptureData.contactInfo || "";
          leadCaptureData.userMessage = leadCaptureData.userMessage || "";
          
          leadCaptureOfferedInTurn = incomingSessionState.leadCapture.offeredInTurn || null;
          leadCaptureDeclinedInSession = typeof incomingSessionState.leadCapture.declinedInSession === 'boolean' ? incomingSessionState.leadCapture.declinedInSession : false;
      }
  } else {
      console.log("DEBUG_CHAT_HANDLER: incomingSessionState es null o inválido, inicializando sessionState por defecto.");
  }

  currentTurnCount = currentTurnCount + 1;

  let sessionState = {
      leadCapture: {
          step: leadCaptureStep,
          data: leadCaptureData,
          offeredInTurn: leadCaptureOfferedInTurn,
          declinedInSession: leadCaptureDeclinedInSession
      },
      turnCount: currentTurnCount
  };
  // ======== FIN DE CORRECCIÓN EN INICIALIZACIÓN DE sessionState ========
  
  console.log("DEBUG_CHAT_HANDLER: Current sessionState (after potential init/increment):", JSON.stringify(sessionState, null, 2));
  
  let conversationHistory = Array.isArray(incomingConversationHistory) ? incomingConversationHistory : [];
  
  if (typeof logRigbotMessage === "function" && message) { 
    try { 
        console.log(`DEBUG_CHAT_HANDLER: Logging user message to Firestore: "${message}"`);
        await logRigbotMessage({ role: "user", content: message, sessionId: currentSessionId, ip: ipAddress, clientId: requestClientId }); 
    } 
    catch (logErr) { console.error("Error al loguear mensaje de usuario en Firestore (chat.js):", logErr); }
  }
  
  if (conversationHistory.length === 0 || 
      (conversationHistory.length > 0 && conversationHistory[conversationHistory.length -1]?.role !== 'user') ||
      (conversationHistory.length > 0 && conversationHistory[conversationHistory.length -1]?.content !== message)
     ) {
      if(message){ 
          console.log("DEBUG_CHAT_HANDLER: User message added/updated in internal conversationHistory.");
          conversationHistory.push({role: "user", content: message});
      }
  }
  console.log("DEBUG_CHAT_HANDLER: Current full conversationHistory for processing:", JSON.stringify(conversationHistory, null, 2));
  
  const effectiveConfig = getEffectiveConfig(clientConfigData); 
  console.log("🧠 Configuración efectiva usada (orquestador) para clientId", requestClientId, ":");
  console.log("   leadCaptureEnabled:", effectiveConfig.leadCaptureEnabled);
  console.log("   clinicNameForLeadPrompt:", effectiveConfig.clinicNameForLeadPrompt);
  
  try {
    const lowerMessage = message ? message.toLowerCase() : ""; 
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
                botResponseText = (effectiveConfig.leadCaptureConfirmationPromptTemplate || `¡Listo, {userName}! Hemos guardado tus datos. {clinicName} se pondrá en contacto contigo. Mientras tanto, ¿puedo ayudarte con algo más?`)
                    .replace(/{userName}/g, sessionState.leadCapture.data.name || "tú")
                    .replace(/{clinicName}/g, effectiveConfig.clinicNameForLeadPrompt || effectiveConfig.name || "La clínica");
                sessionState.leadCapture.step = 'completed_this_session'; 
                sessionState.leadCapture.data = { name: "", contactInfo: "", userMessage: "" };
                break;
        }
    } else if (sessionState.leadCapture.step === 'offered') {
        console.log("DEBUG_CHAT_HANDLER: Handling response to lead capture offer.");
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
            botResponseText = (effectiveConfig.leadCaptureContactPromptTemplate || `Gracias, {userName}. ¿Cuál es tu email o teléfono?`)
                                .replace("{userName}", userNameFromMessage);
            sessionState.leadCapture.step = 'awaiting_contact'; 
        } else if (affirmativeMatch && !negativeMatch) { 
            botResponseText = effectiveConfig.leadCaptureNamePrompt || "¿Cuál es tu nombre?";
            sessionState.leadCapture.step = 'awaiting_name';
        } else if (negativeMatch) { 
            botResponseText = effectiveConfig.leadCaptureDeclinedMessage || "Entendido. Si cambias de opinión, solo avísame. ¿Cómo puedo ayudarte hoy con tus consultas o horarios?";
            sessionState.leadCapture.step = 'declined_this_session'; 
        } else { 
            console.log("DEBUG (chat.js): Usuario ignoró/respondió ambiguamente a oferta de lead, se procesará su consulta.");
            sessionState.leadCapture.step = 'postponed_in_session'; 
            leadCaptureFlowHandled = false; 
        }
    }

    if (!leadCaptureFlowHandled) {
        let primaryResponse = "";
        let shouldOfferLeadNow = 
            effectiveConfig.leadCaptureEnabled &&
            (sessionState.leadCapture.step === null || sessionState.leadCapture.step === 'postponed_in_session') &&
            !sessionState.leadCapture.declinedInSession &&
            sessionState.turnCount <= 2; 

        // Si es el primer turno del usuario (turnCount === 1 porque ya lo incrementamos),
        // Y vamos a ofrecer lead (shouldOfferLeadNow es true),
        // Y el estado actual de lead es null (no 'postponed' o similar)
        // Y NO es una consulta de calendario (para priorizar responder eso)
        // ENTONCES la oferta de lead ES la respuesta principal.
        if (sessionState.turnCount === 1 && shouldOfferLeadNow && sessionState.leadCapture.step === null && !isCalendarQuery(lowerMessage)) {
            console.log("DEBUG_CHAT_HANDLER: Turno 1, NO es query de calendario, se ofrecerá lead. La oferta será la respuesta principal.");
            const clinicName = effectiveConfig.clinicNameForLeadPrompt || effectiveConfig.name || "la clínica";
            botResponseText = (effectiveConfig.leadCaptureOfferPromptTemplate || 
                               `¡Hola! Soy RigBot de {clinicName}. Para una atención más directa o si prefieres que te llamemos, ¿te gustaría dejar tu nombre y contacto? También puedo ayudarte con tus consultas sobre horarios o servicios.`)
                               .replace(/{clinicName}/g, clinicName); 
            
            sessionState.leadCapture.step = 'offered';
            sessionState.leadCapture.offeredInTurn = sessionState.turnCount;
            console.log(`DEBUG_CHAT_HANDLER: (Turno 1 directo - no calendario) Estado de Lead Capture seteado a 'offered'.`);
        } else {
            if (isCalendarQuery(lowerMessage)) {
                const serverNowUtc = new Date();
                const currentYearChile = parseInt(new Intl.DateTimeFormat('en-US', { year: 'numeric', timeZone: 'America/Santiago' }).format(serverNowUtc), 10);
                const currentMonthForRef = parseInt(new Intl.DateTimeFormat('en-US', { month: 'numeric', timeZone: 'America/Santiago' }).format(serverNowUtc), 10) -1;
                const currentDayForRef = parseInt(new Intl.DateTimeFormat('en-US', { day: 'numeric', timeZone: 'America/Santiago' }).format(serverNowUtc), 10);
                const refDateTimestamp = Date.UTC(currentYearChile, currentMonthForRef, currentDayForRef, 0 - CHILE_UTC_OFFSET_HOURS, 0, 0, 0);
                const refDateForTargetCalc = new Date(refDateTimestamp);

                const queryDetails = parseDateTimeQuery(lowerMessage, effectiveConfig, serverNowUtc, refDateForTargetCalc, requestClientId);

                if (queryDetails.earlyResponse) { 
                    primaryResponse = queryDetails.earlyResponse.response;
                } else {
                    const calendar = await getCalendarInstance(requestClientId, clientConfigData); 
                    if (!calendar) {
                        primaryResponse = "Lo siento, estoy teniendo problemas para conectar con el servicio de calendario en este momento.";
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
                            primaryResponse = 'Error al consultar el calendario de Google.';
                        }
                        
                        if (busySlots) { 
                            const availableSlotsOutput = getAvailableSlots(
                                busySlots, queryDetails, effectiveConfig, 
                                serverNowUtc, refDateForTargetCalc, 
                                calendarQueryStartUtc, requestClientId
                            );
                            primaryResponse = buildCalendarResponse(
                                availableSlotsOutput, queryDetails, effectiveConfig, 
                                serverNowUtc, refDateForTargetCalc, busySlots, 
                                currentYearChile, requestClientId
                            );
                        } else if (!primaryResponse) { 
                            primaryResponse = "Hubo un problema obteniendo la disponibilidad del calendario.";
                        }
                    }
                }
            } else { 
              primaryResponse = await getOpenAIReply(message, effectiveConfig, requestClientId); 
            }
            botResponseText = primaryResponse;

            if (shouldOfferLeadNow && sessionState.leadCapture.step !== 'offered') { 
                console.log(`DEBUG_CHAT_HANDLER: Turno ${sessionState.turnCount}, añadiendo oferta de lead a la respuesta existente: "${botResponseText}"`);
                const clinicName = effectiveConfig.clinicNameForLeadPrompt || effectiveConfig.name || "la clínica";
                const offerPromptAddition = (effectiveConfig.leadCaptureOfferPromptTemplate || 
                                           `Para una atención más directa, ¿te gustaría dejar tu nombre y contacto?`)
                                           .replace(/{clinicName}/g, clinicName).split('\n\n').pop(); 
                
                botResponseText = (botResponseText || (effectiveConfig.fallbackMessage || "Entendido.")) + `\n\n${offerPromptAddition}`;
                
                sessionState.leadCapture.step = 'offered';
                sessionState.leadCapture.offeredInTurn = sessionState.turnCount;
                console.log(`DEBUG_CHAT_HANDLER: (Turno > 1 o pospuesto) Estado de Lead Capture seteado a 'offered'.`);
            }
        }
    }
    
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