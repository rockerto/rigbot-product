// /pages/api/widget.js
import { db } from '@/lib/firebase-admin'; // Necesario para leer config del cliente
import { getEffectiveConfig, defaultConfig } from '@/lib/chat_modules/config_manager'; // Para obtener config y defaults

export default async function handler(req, res) {
  const clientId = req.query.clientId || "demo-client";
  const clave = req.query.clave || null; // La clave se pasa para el widget core, no se usa aquí directamente

  const publicBackendDomain = process.env.NEXT_PUBLIC_RIGBOT_PRODUCT_URL_CANONICAL || "https://rigbot-product.vercel.app";
  const widgetCoreSrc = `${publicBackendDomain}/rigbot-widget-core.js`;

  let initialBotGreeting = defaultConfig.welcomeMessage || "Hola 👋 Soy Rigbot, tu asistente virtual. ¿En qué puedo ayudarte hoy?";
  let leadCaptureInitiallyOffered = false;
  let clientSpecificWhatsapp = defaultConfig.whatsappNumber; // Usar el default como fallback

  try {
    if (clientId !== "demo-client" && db) { // No buscar config para demo-client, usa defaults
      const clientDocRef = db.collection('clients').doc(clientId);
      const clientDocSnap = await clientDocRef.get();
      if (clientDocSnap.exists) {
        const clientConfigData = clientDocSnap.data();
        const effectiveConfig = getEffectiveConfig(clientConfigData); // Usar tu función
        
        clientSpecificWhatsapp = effectiveConfig.whatsappNumber || clientSpecificWhatsapp;

        if (effectiveConfig.leadCaptureEnabled && effectiveConfig.leadCaptureOfferPromptTemplate) {
          const clinicName = effectiveConfig.clinicNameForLeadPrompt || effectiveConfig.name || "la clínica";
          initialBotGreeting = effectiveConfig.leadCaptureOfferPromptTemplate.replace(/{clinicName}/g, clinicName);
          leadCaptureInitiallyOffered = true;
          console.log(`[Rigbot Widget Loader] Lead capture offer will be in initial greeting for ${clientId}.`);
        } else if (effectiveConfig.welcomeMessage) {
          initialBotGreeting = effectiveConfig.welcomeMessage;
        }
      } else {
        console.warn(`[Rigbot Widget Loader] ClientID ${clientId} no encontrado en Firestore. Usando saludos por defecto.`);
      }
    } else if (clientId === "demo-client") {
        // Para demo-client, podríamos hardcodear una oferta si quisiéramos probarla sin Firestore
        // O simplemente usar el default welcome message.
        // Por ahora, usará el defaultConfig.welcomeMessage.
        // Si quieres que demo-client SIEMPRE ofrezca lead capture para pruebas:
        // initialBotGreeting = (defaultConfig.leadCaptureOfferPromptTemplate || "Saludo con oferta default para demo")
        //                         .replace(/{clinicName}/g, "Clínica Demo");
        // leadCaptureInitiallyOffered = true;
        console.log(`[Rigbot Widget Loader] Usando config por defecto para demo-client.`);
    }
  } catch (error) {
    console.error("[Rigbot Widget Loader] Error obteniendo configuración del cliente:", error);
    // Continuar con el saludo por defecto si falla la obtención de config
  }

  // Escapar el mensaje para que sea seguro en un string JS
  const escapedInitialGreeting = initialBotGreeting
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n');

  const scriptContent = `
(() => {
  console.log("[Rigbot Loader Script] Ejecutándose en el navegador del cliente.");
  window.RIGBOT_CLIENT_ID = "${String(clientId)}";
  ${clave ? `window.RIGBOT_CLAVE = "${String(clave)}";` : 'delete window.RIGBOT_CLAVE;'}
  window.RIGBOT_INITIAL_GREETING = "${escapedInitialGreeting}"; // <-- MENSAJE INICIAL DINÁMICO
  window.RIGBOT_LEAD_CAPTURE_INITIALLY_OFFERED = ${leadCaptureInitiallyOffered}; // <-- BANDERA
  window.RIGBOT_WHATSAPP_NUMBER = "${String(clientSpecificWhatsapp)}"; // <-- Número de WhatsApp del cliente
  // La URL base para API del widget core la tomará de su propia lógica (window.NEXT_PUBLIC_RIGBOT_BACKEND_URL o defaults)
  
  console.log("[Rigbot Loader Script] ClientID seteado a:", window.RIGBOT_CLIENT_ID);
  console.log("[Rigbot Loader Script] Clave seteada a:", window.RIGBOT_CLAVE !== undefined ? window.RIGBOT_CLAVE : 'N/A (o eliminada)');
  console.log("[Rigbot Loader Script] Initial Greeting:", window.RIGBOT_INITIAL_GREETING);
  console.log("[Rigbot Loader Script] Lead Capture Initially Offered:", window.RIGBOT_LEAD_CAPTURE_INITIALLY_OFFERED);
  console.log("[Rigbot Loader Script] WhatsApp Number for Widget:", window.RIGBOT_WHATSAPP_NUMBER);

  const coreScriptElement = document.createElement("script");
  console.log("[Rigbot Loader Script] Elemento <script> para el core creado.");
  
  const calculatedCoreSrc = "${widgetCoreSrc}";
  console.log("[Rigbot Loader Script] URL ABSOLUTA calculada para rigbot-widget-core.js:", calculatedCoreSrc);
  
  if (!calculatedCoreSrc || !calculatedCoreSrc.startsWith("http")) {
    console.error("[Rigbot Loader Script] ERROR: La URL para rigbot-widget-core.js es inválida:", calculatedCoreSrc);
    return; 
  }

  coreScriptElement.src = calculatedCoreSrc;
  coreScriptElement.defer = true;
  
  coreScriptElement.onload = () => {
    console.log("[Rigbot Loader Script] rigbot-widget-core.js CARGADO EXITOSAMENTE desde:", calculatedCoreSrc);
  };
  
  coreScriptElement.onerror = (event) => { 
    console.error("[Rigbot Loader Script] ERROR AL CARGAR rigbot-widget-core.js desde:", calculatedCoreSrc, "Evento de error:", event);
    // ... (tu manejo de error de carga del widget)
  };
  
  try {
    console.log("[Rigbot Loader Script] Intentando añadir rigbot-widget-core.js al <head> del documento...");
    document.head.appendChild(coreScriptElement);
    console.log("[Rigbot Loader Script] rigbot-widget-core.js añadido al <head>.");
  } catch (e) {
    console.error("[Rigbot Loader Script] Excepción al intentar añadir coreScriptElement al DOM:", e);
  }
})();
  `.trim();

  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.status(200).send(scriptContent);
}