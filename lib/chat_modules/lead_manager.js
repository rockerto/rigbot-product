// /lib/chat_modules/lead_manager.js
import { db } from '@/lib/firebase-admin'; // Asumiendo que firebase-admin exporta 'db'
import { FieldValue } from 'firebase-admin/firestore';

// TODO: Configurar un servicio de envío de emails (ej. Resend, SendGrid)
// import { Resend } from 'resend';
// const resend = new Resend(process.env.RESEND_API_KEY);

export async function saveLeadToFirestore(clientId, leadData, conversationHistory) {
    if (!clientId || !leadData || !conversationHistory) {
        throw new Error("Faltan datos requeridos para guardar el lead en Firestore.");
    }
    try {
        const clientDocRef = db.collection('clients').doc(clientId);
        const newLeadRef = clientDocRef.collection('leads').doc(); // ID autogenerado

        await newLeadRef.set({
            ...leadData, // { name, contactInfo, userMessage, sourceWidgetUrl }
            conversationHistory,
            createdAt: FieldValue.serverTimestamp(),
            status: "nuevo",
            clientIdOfLeadSource: clientId,
        });
        console.log(`INFO (lead_manager): Lead guardado en Firestore para clientId ${clientId} con ID: ${newLeadRef.id}`);
        return { success: true, leadId: newLeadRef.id };
    } catch (error) {
        console.error(`ERROR (lead_manager): No se pudo guardar el lead en Firestore para clientId ${clientId}. Error: ${error.message}`, error);
        throw error; // Re-lanzar el error para que el llamador lo maneje
    }
}

export async function sendLeadNotificationEmail(recipientEmail, leadData, conversationHistory, clinicName, clientContactName = "Cliente") {
    if (!recipientEmail) {
        console.warn("WARN (lead_manager): No se proveyó recipientEmail para la notificación del lead.");
        return { success: false, error: "Email del destinatario no provisto." };
    }

    const subject = `Nuevo Contacto/Lead desde RigBot para ${clinicName || clientContactName || 'tu clínica'}!`;
    
    let emailBodyHtml = `
        <h1>¡Nuevo Contacto/Lead Recibido vía RigBot!</h1>
        <p>Un usuario ha interactuado con RigBot y ha proporcionado la siguiente información:</p>
        <ul>
            <li><strong>Nombre:</strong> ${leadData.name || 'No proporcionado'}</li>
            <li><strong>Contacto (Email/Teléfono):</strong> ${leadData.contactInfo || 'No proporcionado'}</li>
            <li><strong>Mensaje Adicional:</strong> ${leadData.userMessage || 'Ninguno'}</li>
            <li><strong>Capturado en Página:</strong> ${leadData.sourceWidgetUrl || 'No especificado'}</li>
            <li><strong>Fecha de Captura:</strong> ${new Date().toLocaleString('es-CL', { timeZone: 'America/Santiago' })}</li>
        </ul>
        <hr>
        <h2>Historial de Conversación Completo:</h2>
    `;

    if (conversationHistory && conversationHistory.length > 0) {
        conversationHistory.forEach(msg => {
            const roleDisplay = msg.role === 'user' ? (leadData.name || 'Usuario') : 'RigBot';
            emailBodyHtml += `<p><strong>${roleDisplay}:</strong> ${msg.content}</p>`;
        });
    } else {
        emailBodyHtml += "<p>No hay historial de conversación disponible o no se incluyó.</p>";
    }
    emailBodyHtml += "<hr><p>Por favor, haz seguimiento a este contacto a la brevedad.</p>";

    console.log(`INFO (lead_manager): Preparando email para ${recipientEmail} con asunto: ${subject}`);
    
    // ---- LÓGICA DE ENVÍO DE EMAIL REAL IRÍA AQUÍ ----
    // Ejemplo con Resend (necesitarías instalar 'resend' y configurar RESEND_API_KEY en tus variables de entorno)
    /*
    if (!process.env.RESEND_API_KEY) {
        console.error("ERROR (lead_manager): RESEND_API_KEY no está configurada. No se puede enviar email.");
        return { success: false, error: "Servicio de email no configurado en el servidor." };
    }
    const resend = new Resend(process.env.RESEND_API_KEY);
    try {
        const data = await resend.emails.send({
            from: 'RigBot Notificaciones <onboarding@resend.dev>', // Cambiar por tu email verificado en Resend
            to: [recipientEmail],
            subject: subject,
            html: emailBodyHtml,
        });
        console.log('INFO (lead_manager): Email de notificación de lead enviado exitosamente:', data.id);
        return { success: true, messageId: data.id };
    } catch (error) {
        console.error('ERROR (lead_manager): Fallo al enviar email de notificación de lead con Resend:', error);
        return { success: false, error: error.message };
    }
    */

    // Placeholder mientras no hay servicio de email configurado:
    console.log("SIMULACIÓN (lead_manager): Email de notificación de lead NO ENVIADO (servicio no configurado). Destinatario:", recipientEmail);
    return { success: true, messageId: 'simulated_email_sent_ok' };
}