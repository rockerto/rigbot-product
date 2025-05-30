// /pages/api/save-lead.js
import { db } from '@/lib/firebase-admin'; // Para obtener clientOwnerData
import { logRigbotMessage } from "@/lib/rigbotLog";
import { saveLeadToFirestore, sendLeadNotificationEmail } from '@/lib/chat_modules/lead_manager.js';

export default async function handler(req, res) {
    const allowedOriginsString = process.env.ALLOWED_ORIGINS_WIDGET || (process.env.NODE_ENV === 'development' ? 'http://localhost:3000' : 'https://rigsite-web.vercel.app');
    const allowedOrigins = allowedOriginsString.split(',').map(origin => origin.trim());
    const requestOrigin = req.headers.origin;

    if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
        res.setHeader('Access-Control-Allow-Origin', requestOrigin);
    } else if (process.env.NODE_ENV === 'development' && requestOrigin && requestOrigin.startsWith('http://localhost:')) {
        console.warn("WARN (save-lead endpoint) CORS: Origen de desarrollo localhost permitido:", requestOrigin);
        res.setHeader('Access-Control-Allow-Origin', requestOrigin);
    } 

    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Client-ID, Authorization, X-Rigbot-Clave');
    res.setHeader('Access-Control-Allow-Credentials', 'true');

    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Método no permitido' });
    }
    
    if (requestOrigin && !allowedOrigins.includes(requestOrigin) && !(process.env.NODE_ENV === 'development' && requestOrigin.startsWith('http://localhost:'))) {
        console.warn("WARN (save-lead endpoint) CORS POST: Origen no permitido:", requestOrigin);
        return res.status(403).json({ error: "Origen no permitido por CORS." });
    }

    const {
        clientId, 
        clave,    
        leadData, 
        conversationHistory 
    } = req.body;

    const ipAddress = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'N/A';
    const sessionId = `lead_capture_${Date.now()}`; // Sesión específica para este evento de lead

    if (!clientId || !leadData || !conversationHistory) {
        console.warn(`WARN (save-lead endpoint): Faltan datos requeridos. ClientId: ${clientId}, LeadData: ${!!leadData}, ConvHistory: ${!!conversationHistory}`);
        return res.status(400).json({ error: 'Faltan datos requeridos: clientId, leadData o conversationHistory.' });
    }

    try {
        const clientDocRef = db.collection('clients').doc(clientId);
        const clientDocSnap = await clientDocRef.get();

        if (!clientDocSnap.exists) {
            console.warn(`WARN (save-lead endpoint): Cliente con ID ${clientId} no encontrado para guardar lead.`);
            return res.status(404).json({ error: 'Cliente de RigBot no encontrado.' });
        }
        const clientOwnerData = clientDocSnap.data();

        const expectedClave = clientOwnerData?.clave;
        if (expectedClave && typeof expectedClave === 'string' && expectedClave.trim() !== "") {
            if (expectedClave !== clave) {
                console.warn(`WARN (save-lead endpoint): Clave API incorrecta para clientId '${clientId}'.`);
                if (typeof logRigbotMessage === "function") {
                    try { await logRigbotMessage({ role: "system", content: `Intento de guardar lead con clave incorrecta. Lead: ${JSON.stringify(leadData)}`, sessionId, ip: ipAddress, clientId }); }
                    catch (e) { console.error("Log Error (save-lead endpoint clave incorrecta):", e) }
                }
                return res.status(401).json({ error: "Clave de API incorrecta." });
            }
        } else {
            console.log(`INFO (save-lead endpoint): No se requiere clave para clientId '${clientId}' o no se proveyó, continuando.`);
        }

        // Guardar en Firestore usando el módulo
        const saveResult = await saveLeadToFirestore(clientId, leadData, conversationHistory);
        if (!saveResult.success) {
            // El error ya se logueó dentro de saveLeadToFirestore
            return res.status(500).json({ error: "Error al guardar el lead en la base de datos." });
        }
        
        // Enviar email usando el módulo
        const notificationEmail = clientOwnerData.leadNotificationEmail || clientOwnerData.email;
        const clinicName = clientOwnerData.clinicNameForLeadPrompt || clientOwnerData.name || "tu Clínica";
        const clientNameForEmail = clientOwnerData.name || "Cliente de RigBot"; // Para el saludo en el email

        if (notificationEmail) {
            const emailResult = await sendLeadNotificationEmail(notificationEmail, leadData, conversationHistory, clinicName, clientNameForEmail);
            if (!emailResult.success) {
                // El error ya se logueó dentro de sendLeadNotificationEmail (o se logueará si se implementa envío real)
                // No necesariamente un error fatal para la respuesta al usuario, ya que el lead se guardó.
                console.warn(`WARN (save-lead endpoint): Lead guardado pero email de notificación falló para ${notificationEmail}. Error: ${emailResult.error}`);
            }
        } else {
            console.warn(`WARN (save-lead endpoint): No se encontró email de notificación para clientId ${clientId}. No se envió correo.`);
        }

        if (typeof logRigbotMessage === "function") {
            try {await logRigbotMessage({role: "system", content: `Nuevo lead capturado: ${leadData.name || 'N/A'} (${leadData.contactInfo || 'N/A'}). Email (simulado/enviado) a ${notificationEmail}`, sessionId, ip: ipAddress, clientId }); }
            catch(e){ console.error("Error al loguear captura de lead (save-lead endpoint):", e); }
        }

        return res.status(200).json({ success: true, message: 'Datos de contacto guardados. Nos pondremos en contacto pronto.' });

    } catch (error) {
        console.error(`❌ ERROR (save-lead endpoint) al procesar lead para clientId ${clientId}:`, error.message, error.stack);
        const errorForUser = 'Ocurrió un error al guardar los datos de contacto.';
        if (typeof logRigbotMessage === "function") {
            try {await logRigbotMessage({role: "system", content: `Error al guardar lead (endpoint): ${error.message}. LeadData: ${JSON.stringify(leadData)}`, sessionId, ip: ipAddress, clientId: clientId || "desconocido"});}
            catch(e){ console.error("Error al loguear error de save-lead endpoint:", e); }
        }
        return res.status(500).json({ error: errorForUser, details: error.message });
    }
}