// rigbot-product/pages/api/widget.js
export default function handler(req, res) {
  const clientId = req.query.clientId || "demo-client"; 
  const clave = req.query.clave || null;

  const protocol = process.env.NODE_ENV === 'development' ? 'http://' : 'https://';
  const vercelUrl = process.env.VERCEL_URL; // Variable de entorno de Vercel para el dominio del deployment
  
  // Para desarrollo local, asumimos localhost:3001 o el puerto de rigbot-product
  // Para producción, CONFIAMOS en VERCEL_URL. Si no está, es un problema de configuración del entorno.
  const host = vercelUrl || 
               (process.env.NODE_ENV === 'development' ? `localhost:${process.env.PORT || 3001}` : null);

  // Si 'host' es null en producción, no podemos construir la URL del core widget.
  if (!host && process.env.NODE_ENV === 'production') {
    console.error("[Rigbot API /api/widget] ERROR CRÍTICO: process.env.VERCEL_URL no está definida en el entorno de producción de Vercel. No se puede determinar el host para rigbot-widget-core.js.");
    // Devolver un script que alerte en la consola del navegador del cliente final
    const errorScript = `console.error("[Rigbot Widget Loader] Error crítico de configuración del servidor: no se pudo determinar la URL del script principal del widget. El administrador ha sido notificado (revisar logs del backend /api/widget).");`;
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.status(200).send(errorScript); // Enviamos 200 para que el script se ejecute y muestre el error en la consola del cliente
    return;
  }
  // Si host sigue siendo null (ej. en dev sin VERCEL_URL y sin un fallback de localhost apropiado)
  if (!host) {
    console.error("[Rigbot API /api/widget] ERROR: No se pudo determinar el 'host' para construir la URL de rigbot-widget-core.js. VERCEL_URL: ", vercelUrl, "NODE_ENV: ", process.env.NODE_ENV);
    const errorScript = `console.error("[Rigbot Widget Loader] Error de configuración: No se pudo construir la URL para el script principal del widget.");`;
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.status(200).send(errorScript);
    return;
  }
  
  const widgetCoreSrc = `${protocol}${host}/rigbot-widget-core.js`;

  const scriptContent = `
(() => {
  console.log("[Rigbot Loader Script] Ejecutándose en el navegador del cliente.");
  window.RIGBOT_CLIENT_ID = "${String(clientId)}";
  ${clave ? `window.RIGBOT_CLAVE = "${String(clave)}";` : 'delete window.RIGBOT_CLAVE;'}

  console.log("[Rigbot Loader Script] ClientID seteado a:", window.RIGBOT_CLIENT_ID);
  console.log("[Rigbot Loader Script] Clave seteada a:", window.RIGBOT_CLAVE !== undefined ? window.RIGBOT_CLAVE : 'N/A (o eliminada)');
  
  const coreScriptElement = document.createElement("script");
  console.log("[Rigbot Loader Script] Elemento <script> para el core creado.");
  
  const calculatedCoreSrc = "${widgetCoreSrc}";
  console.log("[Rigbot Loader Script] URL calculada para rigbot-widget-core.js:", calculatedCoreSrc);
  
  if (!calculatedCoreSrc || calculatedCoreSrc.includes('null') || calculatedCoreSrc.includes('undefined')) {
    console.error("[Rigbot Loader Script] ERROR: La URL para rigbot-widget-core.js es inválida o nula:", calculatedCoreSrc);
    return; // No intentar cargar si la URL es mala
  }

  coreScriptElement.src = calculatedCoreSrc;
  coreScriptElement.defer = true;
  
  coreScriptElement.onload = () => {
    console.log("[Rigbot Loader Script] rigbot-widget-core.js CARGADO EXITOSAMENTE desde:", calculatedCoreSrc);
    // Aquí es donde el widget-core debería empezar a hacer su magia (initRigbot, etc.)
    // Si initRigbot no se llama solo, y necesitas llamarlo explícitamente:
    // if (typeof initRigbotGlobal === 'function') { initRigbotGlobal(); } // Asumiendo que widget-core lo expone así
  };
  
  coreScriptElement.onerror = () => {
    console.error("[Rigbot Loader Script] ERROR AL CARGAR rigbot-widget-core.js desde:", calculatedCoreSrc);
    const errorDivId = 'rigbot-core-load-error-notifier';
    if (!document.getElementById(errorDivId)) {
        const errorDiv = document.createElement('div');
        errorDiv.id = errorDivId;
        errorDiv.innerText = 'Error: Rigbot no pudo cargar su componente principal (core). Intente recargar la página o contacte a soporte.';
        errorDiv.style.cssText = 'position:fixed; bottom:20px; left:10px; padding:15px; background:darkred; color:white; z-index:10001; border-radius:8px; font-family: sans-serif; font-size: 14px; box-shadow: 0 4px 12px rgba(0,0,0,0.3);';
        document.body.appendChild(errorDiv);
        // No lo removemos automáticamente para que el error sea visible
        // setTimeout(() => { if(document.getElementById(errorDivId)) document.getElementById(errorDivId).remove(); }, 7000);
    }
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