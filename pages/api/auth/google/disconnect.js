// /pages/api/auth/google/disconnect.js
import { auth as adminAuth, db } from '@/lib/firebase-admin'; // Asegúrate que la ruta a tu firebase-admin.ts sea correcta
import { google } from 'googleapis';
import { logRigbotMessage } from "@/lib/rigbotLog"; // Asegúrate que la ruta a tu rigbotLog es correcta

export default async function handler(req, res) {
    // Configuración de CORS - Asegúrate que ALLOWED_ORIGINS apunte a tu rigsite-web
    const allowedOriginsString = process.env.ALLOWED_ORIGINS || (process.env.NODE_ENV === 'development' ? 'http://localhost:3000' : 'https://rigsite-web.vercel.app');
    const allowedOrigins = allowedOriginsString.split(',').map(origin => origin.trim());
    const requestOrigin = req.headers.origin;

    if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
        res.setHeader('Access-Control-Allow-Origin', requestOrigin);
    } else if (process.env.NODE_ENV === 'development' && requestOrigin && requestOrigin.startsWith('http://localhost:')) {
        // En desarrollo, podríamos ser más permisivos si el puerto de rigsite-web cambia
        console.log("WARN (disconnect.js): Origen de desarrollo localhost permitido:", requestOrigin);
        res.setHeader('Access-Control-Allow-Origin', requestOrigin);
    } else {
        console.warn("WARN (disconnect.js) CORS: Origen no permitido:", requestOrigin, "| Permitidos:", allowedOrigins.join(' '));
        // No retornar aquí para OPTIONS, pero sí para otras peticiones si no coincide.
    }

    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Credentials', 'true');

    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Método no permitido' });
    }

    // Validar que el origen sea uno de los permitidos si no es una preflight OPTIONS
    if (requestOrigin && !allowedOrigins.includes(requestOrigin) && !(process.env.NODE_ENV === 'development' && requestOrigin.startsWith('http://localhost:'))) {
        console.warn("WARN (disconnect.js) CORS POST: Origen no permitido:", requestOrigin);
        return res.status(403).json({ error: "Origen no permitido por CORS." });
    }


    const authorizationHeader = req.headers.authorization;
    if (!authorizationHeader || !authorizationHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Token de autorización ausente o malformado.' });
    }
    const idToken = authorizationHeader.split('Bearer ')[1];

    let uid; // Para usar en el log final de error si verifyIdToken falla

    try {
        const decodedToken = await adminAuth.verifyIdToken(idToken);
        uid = decodedToken.uid; // Este es tu clientId

        console.log(`INFO (disconnect.js): Solicitud de desconexión de calendario para clientId (uid): ${uid}`);

        const clientDocRef = db.collection('clients').doc(uid);
        const clientDoc = await clientDocRef.get();

        if (!clientDoc.exists) {
            console.warn(`WARN (disconnect.js): No se encontró cliente con uid: ${uid} para desconectar calendario.`);
            return res.status(404).json({ error: 'Cliente no encontrado.' });
        }

        const clientData = clientDoc.data();
        let tokenRevoked = false;

        if (clientData && clientData.googleCalendarTokens) {
            const oauth2Client = new google.auth.OAuth2(
                process.env.GOOGLE_CLIENT_ID,
                process.env.GOOGLE_CLIENT_SECRET
                // No se necesita redirect URI para revocar
            );
            
            // Google recomienda intentar revocar el access token primero si está disponible y es reciente.
            // Si no, el refresh token. Si solo tenemos refresh token, ese.
            let tokenToRevoke = clientData.googleCalendarTokens.access_token || clientData.googleCalendarTokens.refresh_token;

            if (tokenToRevoke) {
                try {
                    // setCredentials podría ser necesario si el token de acceso es el que se revoca
                    // y la librería necesita autenticarse para la revocación
                    // oauth2Client.setCredentials(clientData.googleCalendarTokens); NO, setCredentials es para usar los tokens, no para revocarlos directamente
                    
                    await oauth2Client.revokeToken(tokenToRevoke);
                    console.log(`INFO (disconnect.js): Token (access o refresh) revocado en Google para clientId: ${uid}`);
                    tokenRevoked = true;
                } catch (revokeError) {
                    console.warn(`WARN (disconnect.js): Fallo al revocar token en Google para clientId: ${uid}. Error: ${revokeError.message}. Procediendo a limpiar en Firestore.`);
                    // Si la revocación falla (ej. token ya inválido), igual continuamos para limpiar nuestros datos.
                }
            } else {
                console.log(`INFO (disconnect.js): No se encontraron tokens específicos (access/refresh) para revocar para clientId: ${uid}. Solo se limpiará Firestore.`);
            }
        } else {
            console.log(`INFO (disconnect.js): No hay googleCalendarTokens en Firestore para clientId: ${uid}. Solo se asegurará el estado de desconexión.`);
        }

        await clientDocRef.update({
            googleCalendarConnected: false,
            googleCalendarTokens: null, // O FieldValue.delete() si prefieres borrar el campo
            googleCalendarEmail: null,
            googleCalendarUserName: null,
            googleCalendarError: null,
            googleCalendarLastSync: null 
        });

        console.log(`INFO (disconnect.js): Calendario desconectado exitosamente en Firestore para clientId: ${uid}`);
        
        const ipAddress = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'N/A';
        const sessionId = req.body.sessionId || `disconnect_${uid}`; // Usar sessionId si viene, sino generar uno

        if (typeof logRigbotMessage === "function") {
            try {
                await logRigbotMessage({
                    role: "system", // O "user" si se considera una acción del usuario
                    content: `Cliente ${uid} desconectó su Google Calendar (Token revocado en Google: ${tokenRevoked}).`, 
                    sessionId: sessionId, 
                    ip: ipAddress, 
                    clientId: uid
                });
            } catch(e){ 
                console.error("Error al loguear desconexión (disconnect.js):", e); 
            }
        }
        
        return res.status(200).json({ success: true, message: 'Calendario desconectado exitosamente.' });

    } catch (error) {
        const errorClientId = uid || 'desconocido'; // Usar uid si ya lo obtuvimos
        console.error(`ERROR (disconnect.js): Error al verificar token o al desconectar calendario para clientId ${errorClientId}:`, error);
        return res.status(403).json({ error: 'Token inválido o error en el proceso de desconexión.' });
    }
}