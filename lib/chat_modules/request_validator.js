// /lib/chat_modules/request_validator.js
import { db } from '@/lib/firebase-admin'; // Asegúrate que la ruta a firebase-admin es correcta
import { logRigbotMessage } from "@/lib/rigbotLog"; // Asegúrate que la ruta a rigbotLog es correcta

export async function validateRequest(req, res) {
  const allowedOriginsString = process.env.ALLOWED_ORIGINS || "https://rigsite-web.vercel.app"; // Considera mover a env vars
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Client-ID, Authorization'); // X-Rigbot-Clave
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    if (corsOriginSet) {
      res.status(204).end();
      return { handled: true, error: null, clientConfigData: null, requestData: null };
    } else {
      res.status(403).json({ error: "Origen no permitido por CORS." });
      return { handled: true, error: "CORS Origin Not Allowed", clientConfigData: null, requestData: null };
    }
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método no permitido' });
    return { handled: true, error: "Method Not Allowed", clientConfigData: null, requestData: null };
  }

  const { message, sessionId: providedSessionId, clientId: bodyClientId, clave: incomingClave } = req.body || {};
  const requestClientId = bodyClientId; // Forzamos que venga del body
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
  let clientConfigData;
  try {
    const clientDocRef = db.collection('clients').doc(requestClientId);
    clientDocSnap = await clientDocRef.get();
    if (!clientDocSnap.exists) {
      console.warn(`API Chat (request_validator): ClientId '${requestClientId}' no registrado en Firestore. Acceso denegado.`);
      res.status(403).json({ error: "Client ID no registrado. Acceso denegado." });
      return { handled: true, error: 'Client ID not registered', clientConfigData: null, requestData: null };
    }
    clientConfigData = clientDocSnap.data();
    console.log(`API Chat (request_validator): Configuración del cliente ${requestClientId} obtenida de Firestore.`);
  } catch (error) {
    console.error(`API Chat (request_validator): Error al verificar clientId '${requestClientId}' en Firestore:`, error);
    res.status(500).json({ error: "Error interno al verificar el cliente." });
    return { handled: true, error: 'Firestore error verifying client', clientConfigData: null, requestData: null };
  }

  const expectedClave = clientConfigData?.clave;
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
  
  if (!message) {
      const errorResponsePayload = { error: 'Falta el mensaje del usuario' };
      if (typeof logRigbotMessage === "function") { try { await logRigbotMessage({ role: "assistant", content: `Error: ${errorResponsePayload.error}`, sessionId: currentSessionId, ip: ipAddress, clientId: requestClientId }); } catch(e){console.error("Log Error (request_validator):",e)} }
      res.status(400).json(errorResponsePayload);
      return { handled: true, error: 'Missing user message', clientConfigData: null, requestData: null };
  }

  // Loguear el mensaje del usuario si todas las validaciones pasaron
  if (typeof logRigbotMessage === "function") { 
    try { await logRigbotMessage({ role: "user", content: message, sessionId: currentSessionId, ip: ipAddress, clientId: requestClientId }); } 
    catch (logErr) { console.error("Error al loguear mensaje de usuario en Firestore (request_validator):", logErr); }
  }

  return {
    handled: false, // Indica que el request es válido y debe continuar
    error: null,
    clientConfigData, // Datos de configuración del cliente desde Firestore
    requestData: { message, sessionId: currentSessionId, clientId: requestClientId, ipAddress } // Datos relevantes del request
  };
}