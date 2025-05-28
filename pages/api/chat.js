// rigbot-product/pages/api/chat.js

import { getCalendarClient } from '@/lib/google';

import OpenAI from 'openai';

import { logRigbotMessage } from "@/lib/rigbotLog";

import { DEFAULT_SYSTEM_PROMPT_TEMPLATE } from '@/lib/defaultSystemPromptTemplate';

import { db } from '@/lib/firebase-admin'; // db se inicializa en firebase-admin.ts

// 'doc' y 'getDoc' para Admin SDK se acceden a través de la instancia db: db.collection().doc() y docRef.get()



const openai = new OpenAI({

  apiKey: process.env.OPENAI_API_KEY

});



const MODEL_FALLBACK = process.env.OPENAI_MODEL || 'gpt-4o';

const CHILE_UTC_OFFSET_HOURS = -4;

const WHATSAPP_FALLBACK_PLACEHOLDER = "+56900000000";



const defaultConfig = {

  basePrompt: process.env.RIGBOT_PROMPT || DEFAULT_SYSTEM_PROMPT_TEMPLATE,

  calendarQueryDays: 7,

  calendarMaxUserRequestDays: 21,

  maxSuggestions: 5,

  whatsappNumber: process.env.RIGBOT_DEFAULT_WSP || WHATSAPP_FALLBACK_PLACEHOLDER,

  pricingInfo: "Nuestros precios son competitivos. Por favor, consulta al contactarnos.",

  direccion: "Nuestra consulta está en Copiapó. Te daremos los detalles exactos al agendar.",

  horario: "Atendemos de Lunes a Viernes, de 10:00 a 19:30.",

  chiropracticVideoUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",

  telefono: ""

};



// La función getClientConfig se integrará/modificará dentro del handler principal para acceso directo

// a clientDocSnap y para manejar los errores de seguridad directamente.



// ... (tus funciones convertChileTimeToUtc y getDayIdentifier se mantienen igual) ...

function convertChileTimeToUtc(baseDateUtcDay, chileHour, chileMinute) {

  let utcHour = chileHour - CHILE_UTC_OFFSET_HOURS;

  const newUtcDate = new Date(baseDateUtcDay);

  newUtcDate.setUTCHours(utcHour, chileMinute, 0, 0);

  return newUtcDate;

}



function getDayIdentifier(dateObj, timeZone) {

  return new Intl.DateTimeFormat('en-CA', {

    year: 'numeric', month: '2-digit', day: '2-digit',

    timeZone: timeZone

  }).format(dateObj);

}



export default async function handler(req, res) {

  const allowedOriginsString = process.env.ALLOWED_ORIGINS || "https://rigsite-web.vercel.app";

  const allowedOrigins = allowedOriginsString.split(',').map(origin => origin.trim());

  const requestOrigin = req.headers.origin;

  let corsOriginSet = false;



  if (requestOrigin) {

    if (allowedOrigins.includes(requestOrigin)) {

      res.setHeader('Access-Control-Allow-Origin', requestOrigin);

      corsOriginSet = true;

    } else if (process.env.NODE_ENV === 'development' && requestOrigin.startsWith('http://localhost:')) {

      res.setHeader('Access-Control-Allow-Origin', requestOrigin);

      corsOriginSet = true;

      console.log("INFO CORS: Origen localhost de desarrollo permitido:", requestOrigin);

    } else {

      console.warn("WARN CORS: Origen no está en la lista de permitidos y no es localhost dev:", requestOrigin, "| Permitidos:", allowedOrigins.join(' '));

    }

  } else {

    console.log("INFO CORS: No se detectó header 'origin'. Se asume same-origin o no-CORS (ej. Postman).");

  }

  

  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Client-ID, Authorization'); // Considera añadir 'X-Rigbot-Clave' si la envías por header

  res.setHeader('Access-Control-Allow-Credentials', 'true');



  if (req.method === 'OPTIONS') {

    console.log("INFO: Recibida solicitud OPTIONS para CORS preflight desde:", requestOrigin, "| CORS permitido para origin?:", corsOriginSet);

    if (corsOriginSet) {

        return res.status(204).end(); 

    } else {

        console.warn("WARN CORS: Solicitud OPTIONS de origen no permitido:", requestOrigin, "será bloqueada por el navegador si no es same-origin.");

        return res.status(403).json({ error: "Origen no permitido por CORS."}); 

    }

  }



  if (req.method !== 'POST') { // Mover esta verificación más arriba

    const errorResponsePayload = { error: 'Método no permitido' };

    // No hay sessionId ni ipAddress definidos aún aquí para loguear, considerar si es necesario

    return res.status(405).json(errorResponsePayload);

  }



  // Desestructurar el cuerpo de la solicitud

  const { message, sessionId: providedSessionId, clientId: bodyClientId, clave: incomingClave } = req.body || {};

  

  // Determinar el clientId a usar

  // Si la clave es para autenticar el widget con el cliente, el clientId siempre debe venir del cuerpo.

  // No debería haber un fallback a 'demo-client' si la seguridad depende del clientId y la clave.

  const requestClientId = bodyClientId; //  Quitamos || req.headers['x-client-id'] || "demo-client"; para que sea estricto del body



  console.log(`INFO: Request entrante POST para /api/chat. ClientId desde body: ${requestClientId}, Clave desde body: ${incomingClave ? 'Presente' : 'Ausente'}`);



  const ipAddress = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null;

  const currentSessionId = providedSessionId || `session_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;



  if (!db) { 

      console.error("FATAL en chat.js: Instancia de Firestore (db) NO DISPONIBLE...");

      return res.status(500).json({ error: 'Error interno crítico del servidor. Contacta al administrador.' });

  }



  // --- INICIO FASE 1: Validar clientId ---

  if (!requestClientId || typeof requestClientId !== 'string') {

    console.warn('API Chat: Intento de acceso con clientId no válido o no proporcionado en el body.');

    // No loguear a Firestore aquí ya que no tenemos un clientId válido.

    return res.status(400).json({ error: "Client ID no válido o no proporcionado." });

  }

  // Evitar que "demo-client" o similar accedan a lógica protegida si no deberían.

  // Si "demo-client" es para un demo público sin clave, esta lógica necesitaría ajustarse.

  // Por ahora, asumimos que todo clientId debe existir en Firestore para mayor seguridad.



  let clientDocSnap;

  let clientConfigData;

  try {

    const clientDocRef = db.collection('clients').doc(requestClientId);

    clientDocSnap = await clientDocRef.get();



    if (!clientDocSnap.exists) {

      console.warn(`API Chat: ClientId '${requestClientId}' no registrado en Firestore. Acceso denegado.`);

      // No loguear a Firestore aquí.

      return res.status(403).json({ error: "Client ID no registrado. Acceso denegado." });

    }

    clientConfigData = clientDocSnap.data(); // Obtenemos los datos aquí

    console.log(`API Chat: Configuración encontrada para clientId: ${requestClientId}`);



  } catch (error) {

    console.error(`API Chat: Error al verificar clientId '${requestClientId}' en Firestore:`, error);

    // No loguear a Firestore aquí.

    return res.status(500).json({ error: "Error interno al verificar el cliente." });

  }

  // --- FIN FASE 1 ---



  // --- INICIO FASE 2: Validar clave si existe ---

  const expectedClave = clientConfigData?.clave; // La clave guardada en Firestore para este cliente



  // Si existe una clave configurada en Firestore para este cliente Y NO es una cadena vacía

  if (expectedClave && typeof expectedClave === 'string' && expectedClave.trim() !== "") {

    if (expectedClave !== incomingClave) { 

      console.warn(`API Chat: Clave incorrecta para clientId '${requestClientId}'. Recibida: '${incomingClave}', Esperada: (no mostrar en logs)`);

      // Loguear el intento fallido, ahora que tenemos un clientId válido.

      if (typeof logRigbotMessage === "function") { 

        try { await logRigbotMessage({ role: "system", content: `Intento de acceso con clave incorrecta. UserMsg: ${message}`, sessionId: currentSessionId, ip: ipAddress, clientId: requestClientId }); } catch(e){console.error("Log Error:",e)} 

      }

      return res.status(401).json({ error: "Clave de API incorrecta para este Client ID." });

    }

    console.log(`API Chat: Clave validada exitosamente para clientId '${requestClientId}'.`);

  }

  // Si no hay 'expectedClave' en Firestore (o es vacía), no se requiere validación de clave, la solicitud continúa.

  // --- FIN FASE 2 ---



  // Continuación de la lógica del handler...

  if (!message) {

    const errorResponsePayload = { error: 'Falta el mensaje del usuario' };

    if (typeof logRigbotMessage === "function") { try { await logRigbotMessage({ role: "assistant", content: `Error: ${errorResponsePayload.error}`, sessionId: currentSessionId, ip: ipAddress, clientId: requestClientId }); } catch(e){console.error("Log Error:",e)} }

    return res.status(400).json(errorResponsePayload);

  }



  if (typeof logRigbotMessage === "function") { 

    try {

      await logRigbotMessage({ role: "user", content: message, sessionId: currentSessionId, ip: ipAddress, clientId: requestClientId });

    } catch (logErr) {

      console.error("Error al loguear mensaje de usuario en Firestore:", logErr);

    }

  }



  // Ya tenemos clientConfigData de la Fase 1

  let effectiveConfig = { ...defaultConfig };



  if (clientConfigData) { // clientConfigData ya está definido y verificado

    console.log("INFO: Datos crudos desde Firestore:", JSON.stringify(clientConfigData, null, 2));

    effectiveConfig.basePrompt = clientConfigData.basePrompt || defaultConfig.basePrompt;

    // ... (resto de la asignación de effectiveConfig como lo tenías) ...

    effectiveConfig.whatsappNumber = clientConfigData.whatsappNumber || defaultConfig.whatsappNumber;

    effectiveConfig.pricingInfo = clientConfigData.pricingInfo || defaultConfig.pricingInfo;

    effectiveConfig.direccion = clientConfigData.direccion || defaultConfig.direccion;

    effectiveConfig.horario = clientConfigData.horario || defaultConfig.horario;

    effectiveConfig.chiropracticVideoUrl = clientConfigData.chiropracticVideoUrl || defaultConfig.chiropracticVideoUrl;

    effectiveConfig.telefono = clientConfigData.telefono || defaultConfig.telefono;



    const firestoreCalendarQueryDays = Number(clientConfigData.calendarQueryDays);

    if (!isNaN(firestoreCalendarQueryDays) && firestoreCalendarQueryDays > 0) {

        effectiveConfig.calendarQueryDays = firestoreCalendarQueryDays;

    } else if (clientConfigData.calendarQueryDays !== undefined) {

        console.warn(`WARN: calendarQueryDays ('${clientConfigData.calendarQueryDays}') desde Firestore para ${requestClientId} no es válido, usando default: ${defaultConfig.calendarQueryDays}`);

    }

    const firestoreCalendarMaxUserRequestDays = Number(clientConfigData.calendarMaxUserRequestDays);

    if (!isNaN(firestoreCalendarMaxUserRequestDays) && firestoreCalendarMaxUserRequestDays > 0) {

        effectiveConfig.calendarMaxUserRequestDays = firestoreCalendarMaxUserRequestDays;

    } else if (clientConfigData.calendarMaxUserRequestDays !== undefined) {

        console.warn(`WARN: calendarMaxUserRequestDays ('${clientConfigData.calendarMaxUserRequestDays}') desde Firestore para ${requestClientId} no es válido, usando default: ${defaultConfig.calendarMaxUserRequestDays}`);

    }

    const firestoreMaxSuggestions = Number(clientConfigData.maxSuggestions);

    if (!isNaN(firestoreMaxSuggestions) && firestoreMaxSuggestions >= 0) {

        effectiveConfig.maxSuggestions = firestoreMaxSuggestions;

    } else if (clientConfigData.maxSuggestions !== undefined) {

        console.warn(`WARN: maxSuggestions ('${clientConfigData.maxSuggestions}') desde Firestore para ${requestClientId} no es válido, usando default: ${defaultConfig.maxSuggestions}`);

    }



  } else {

    // Este caso ya no debería ocurrir debido a la validación de la Fase 1,

    // a menos que permitas un requestClientId que no esté en Firestore (ej. "demo-client" sin config)

    // Si `requestClientId` siempre debe existir, este else es redundante.

    console.log(`INFO: No se encontraron datos en Firestore para ${requestClientId}, usando configuración por defecto completa (esto no debería pasar si el clientId es obligatorio).`);

  }



  console.log("🧠 Configuración efectiva usada para clientId", requestClientId, ":", JSON.stringify(effectiveConfig, null, 2));



  // ... (resto de tu lógica de getWhatsappContactMessage, isCalendarQuery, OpenAI, etc.)

  // Asegúrate de pasar `clientId: requestClientId` a `logRigbotMessage` en todas las llamadas.



  try {

    console.log(`📨 Mensaje ("${message}") recibido para ${requestClientId}`);

    const lowerMessage = message.toLowerCase();



    const calendarKeywords = [ /* ... tus keywords ... */ 

        'hora', 'turno', 'disponibilidad', 'agenda', 'cuando', 'horario', 'disponible', 'libre', 'atiendes', 

        'ver', 'revisar', 'chequear', 'consultar', 'lunes', 'martes', 'miercoles', 'miércoles', 'jueves', 

        'viernes', 'sabado', 'sábado', 'domingo', 'hoy', 'mañana', 'tarde', 'a las', 'para el', 

        'tienes algo', 'hay espacio', 'agendar', 'agendamiento', 'proxima semana', 'próxima semana', 

        'prixima semana', 'procsima semana', 'proxima semama', 'proximo', 'próximo', 'priximo', 'procsimo'

    ];

    const isCalendarQuery = calendarKeywords.some(keyword => lowerMessage.includes(keyword));



    if (isCalendarQuery) {

      // ... (TODA TU LÓGICA DE CALENDARIO COMPLEJA VA AQUÍ) ...

      // Ejemplo simplificado de cómo pasaría el clientId al log:

      // if (typeof logRigbotMessage === "function") { try { await logRigbotMessage({ ..., clientId: requestClientId }); } catch(e){console.error("Log Error:",e)} }

      // return res.status(200).json({ response: replyCalendar });

            console.log('⏳ Detectada consulta de calendario para', requestClientId);

            let calendar;

            try {

              calendar = await getCalendarClient();

              if (!calendar || typeof calendar.events?.list !== 'function') {

                throw new Error("Cliente de calendario no inicializado correctamente.");

              }

            } catch (clientError) {

              console.error("❌ Error al obtener el cliente de Google Calendar para", requestClientId, ":", clientError);

              const errorResponsePayload = { error: 'No se pudo conectar con el servicio de calendario.', details: clientError.message };

              if (typeof logRigbotMessage === "function") { try { await logRigbotMessage({ role: "assistant", content: `Error interno: ${errorResponsePayload.error} Detalles: ${errorResponsePayload.details}`, sessionId: currentSessionId, ip: ipAddress, clientId: requestClientId });} catch(e){console.error("Log Error:",e)} }

              return res.status(500).json(errorResponsePayload);

            }

            

            // ... (Aquí iría tu lógica detallada de manejo de calendario, que es bastante extensa)

            // Me aseguraré de que cualquier logRigbotMessage dentro de esta sección también reciba requestClientId

            // Ejemplo de una respuesta de calendario (debes adaptar tu lógica existente)



            // Esta es solo una simulación de la lógica del calendario

            const availableSlotsOutput = ["lunes, 26 de mayo, 06:30 p. m."]; // Simulación

            let replyCalendar = 'Simulación: Hay horas disponibles.';

            if (availableSlotsOutput.length > 0) {

                 replyCalendar = `¡Buenas noticias! 🎉 Encontré estas horitas disponibles:\n- ${availableSlotsOutput.join('\n- ')}\n\nPara reservar alguna o si buscas otra opción, ¡Escríbenos por WhatsApp al 👉 ${effectiveConfig.whatsappNumber}!`;

            } else {

                 replyCalendar = `¡Pucha! 😔 Parece que no tengo horas libres. ¿Te animas a que busquemos en otra fecha?`;

            }



            console.log('✅ Respuesta generada (Calendario Simulada):', replyCalendar);

            if (typeof logRigbotMessage === "function") { try { await logRigbotMessage({ role: "assistant", content: replyCalendar, sessionId: currentSessionId, ip: ipAddress, clientId: requestClientId }); } catch(e){console.error("Log Error:",e)} }

            return res.status(200).json({ response: replyCalendar });

    }



    // --- Rama de OpenAI ---

    console.log('💡 Consulta normal, usando OpenAI para', requestClientId);

    

    let finalSystemPrompt = effectiveConfig.basePrompt;

    // ... (reemplazo de placeholders como lo tenías) ...

    finalSystemPrompt = finalSystemPrompt.replace(/\$\{DAYS_TO_QUERY_CALENDAR\}/g, effectiveConfig.calendarQueryDays.toString());

    finalSystemPrompt = finalSystemPrompt.replace(/\$\{MAX_DAYS_FOR_USER_REQUEST\}/g, effectiveConfig.calendarMaxUserRequestDays.toString());

    if (effectiveConfig.whatsappNumber && effectiveConfig.whatsappNumber !== WHATSAPP_FALLBACK_PLACEHOLDER && effectiveConfig.whatsappNumber.trim() !== "") {

        finalSystemPrompt = finalSystemPrompt.replace(/\$\{whatsappNumber\}/g, effectiveConfig.whatsappNumber);

    } else {

        finalSystemPrompt = finalSystemPrompt.replace(/\$\{whatsappNumber\}/g, "nuestro principal canal de contacto telefónico o digital");

    }

    finalSystemPrompt = finalSystemPrompt.replace(/\$\{pricingInfo\}/g, effectiveConfig.pricingInfo);

    finalSystemPrompt = finalSystemPrompt.replace(/\$\{direccion\}/g, effectiveConfig.direccion);

    finalSystemPrompt = finalSystemPrompt.replace(/\$\{horario\}/g, effectiveConfig.horario);

    finalSystemPrompt = finalSystemPrompt.replace(/\$\{chiropracticVideoUrl\}/g, effectiveConfig.chiropracticVideoUrl);





    console.log(`System Prompt para OpenAI (clientId: ${requestClientId}, primeros 500 chars):`, finalSystemPrompt.substring(0, 500) + "...");



    const chatResponse = await openai.chat.completions.create({

      model: MODEL_FALLBACK,

      messages: [

        { role: 'system', content: finalSystemPrompt },

        { role: 'user', content: message }

      ]

    });



    let gptReply = chatResponse.choices[0].message.content.trim();

    

    console.log('✅ Respuesta generada (OpenAI):', gptReply);

    if (typeof logRigbotMessage === "function") { try { await logRigbotMessage({ role: "assistant", content: gptReply, sessionId: currentSessionId, ip: ipAddress, clientId: requestClientId }); } catch(e){console.error("Log Error:",e)} }

    return res.status(200).json({ response: gptReply });



  } catch (error) {

    console.error(`❌ Error en Rigbot para clientId ${requestClientId}:`, error);

    // console.error(error.stack); // Puede ser muy verboso para producción, pero útil en dev.

    const errorForUser = 'Ocurrió un error inesperado en Rigbot. Por favor, intenta más tarde.';

    if (typeof logRigbotMessage === "function") { try { await logRigbotMessage({ role: "assistant", content: `Error interno: ${error.message}. UserMsg: ${errorForUser}`, sessionId: currentSessionId, ip: ipAddress, clientId: requestClientId }); } catch(e){console.error("Log Error:",e)} }

    return res.status(500).json({ 

        error: errorForUser, 

        details: process.env.NODE_ENV === 'development' ? error.message + (error.stack ? `\nStack: ${error.stack.substring(0,300)}...` : '') : undefined 

    });

  }

}