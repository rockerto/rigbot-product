// /lib/chat_modules/request_validator.js
import { db } from '@/lib/firebase-admin'; 
import { logRigbotMessage } from "@/lib/rigbotLog"; 

// CAMBIO: Volver a export nombrado
export async function validateRequest(req, res) { 
  const allowedOriginsString = process.env.ALLOWED_ORIGINS || "https://rigsite-web.vercel.app"; // O tu URL de frontend
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
    }
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Client-ID, Authorization, X-Rigbot-Clave'); 
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    if (corsOriginSet) { // Solo terminar si el origen fue permitido para OPTIONS
      res.status(204).end();
      return { handled: true, error: null, clientConfigData: null, requestData: null };
    } else {
      // Si el origen no está en la lista para OPTIONS, no deberíamos llegar aquí si el navegador cumple CORS
      // pero por si acaso, no enviar headers de permiso.
      console.warn(`WARN (request_validator) CORS OPTIONS: Origen no permitido: ${requestOrigin}`);
      res.status(403).json({ error: "Origen no permitido por CORS para preflight." });
      return { handled: true, error: "CORS Origin Not Allowed for preflight", clientConfigData: null, requestData: null };
    }
  }

  // Para otros métodos, si no se seteó el origen (porque no estaba en la lista), denegar.
  if (!corsOriginSet && requestOrigin && !(process.env.NODE_ENV === 'development' && requestOrigin.startsWith('http://localhost:'))) {
      console.warn(`WARN (request_validator) CORS POST/OTHER: Origen no permitido: ${requestOrigin}`);
      res.status(403).json({ error: "Origen no permitido por CORS." });
      return { handled: true, error: "CORS Origin Not Allowed", clientConfigData: null, requestData: null };
  }


  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método no permitido' });
    return { handled: true, error: "Method Not Allowed", clientConfigData: null, requestData: null };
  }

  const { 
    message, 
    sessionId: providedSessionId, 
    clientId: bodyClientId, 
    clave: incomingClave,
    conversationHistory: incomingConversationHistory, 
    sessionState: incomingSessionState 
  } = req.body || {};
  
  const requestClientId = bodyClientId; 
  const ipAddress = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null;
  const currentSessionId = providedSessionId || `session_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

  console.log(`INFO (request_validator): Request POST. ClientId: ${requestClientId}, Clave: ${incomingClave ? 'Presente' : 'Ausente'}`);

  if (!db) {
    console.error("FATAL (request_validator): Firestore (db) NO DISPONIBLE.");
    res.status(500).json({ error: 'Error interno crítico del servidor.' });
    return { handled: true, error: 'Firestore not available', clientConfigData: null, requestData: null };
  }

  if (!requestClientId || typeof requestClientId !== 'string') {
    console.warn('API Chat (request_validator): Intento de acceso con clientId no válido o no proporcionado en el body.');
    res.status(400).json({ error: "Client ID no válido o no proporcionado." });
    return { handled: true, error: 'Invalid Client ID', clientConfigData: null, requestData: null };
  }

  let clientDocSnap;
  let clientConfigDataFromFirestore;
  try {
    const clientDocRef = db.collection('clients').doc(requestClientId);
    clientDocSnap = await clientDocRef.get();
    if (!clientDocSnap.exists) {
      console.warn(`API Chat (request_validator): ClientId '${requestClientId}' no registrado en Firestore. Acceso denegado.`);
      res.status(403).json({ error: "Client ID no registrado. Acceso denegado." });
      return { handled: true, error: 'Client ID not registered', clientConfigData: null, requestData: null };
    }
    clientConfigDataFromFirestore = clientDocSnap.data();
    console.log(`API Chat (request_validator): Configuración del cliente ${requestClientId} obtenida de Firestore.`);
  } catch (error) {
    console.error(`API Chat (request_validator): Error al verificar clientId '${requestClientId}' en Firestore:`, error);
    res.status(500).json({ error: "Error interno al verificar el cliente." });
    return { handled: true, error: 'Firestore error verifying client', clientConfigData: null, requestData: null };
  }

  const expectedClave = clientConfigDataFromFirestore?.clave;
  if (expectedClave && typeof expectedClave === 'string' && expectedClave.trim() !== "") {
    if (expectedClave !== incomingClave) {
      if (typeof logRigbotMessage === "function") {
        try { await logRigbotMessage({ role: "system", content: `Intento de acceso con clave incorrecta. UserMsg: ${message || ''}`, sessionId: currentSessionId, ip: ipAddress, clientId: requestClientId }); }
        catch (e) { console.error("Log Error (request_validator):", e) }
      }
      res.status(401).json({ error: "Clave de API incorrecta para este Client ID." });
      return { handled: true, error: 'Invalid API Key', clientConfigData: null, requestData: null };
    }
  }
  
  // Esta validación de 'message' es para el /api/chat. Si este módulo se reutiliza para otros endpoints
  // que no requieran 'message', esta lógica tendría que ser condicional.
  if (!message && req.url === '/api/chat') { // Solo hacer obligatorio el mensaje para /api/chat
      const errorResponsePayload = { error: 'Falta el mensaje del usuario para /api/chat' };
      // No loguear a logRigbotMessage aquí si es un error de validación muy temprano
      res.status(400).json(errorResponsePayload);
      return { handled: true, error: 'Missing user message for /api/chat', clientConfigData: null, requestData: null };
  }

  return {
    handled: false, 
    error: null,
    clientConfigData: clientConfigDataFromFirestore, 
    requestData: { 
        message, 
        sessionId: currentSessionId, 
        clientId: requestClientId, 
        ipAddress,
        conversationHistory: incomingConversationHistory, 
        sessionState: incomingSessionState 
    }
  };
}