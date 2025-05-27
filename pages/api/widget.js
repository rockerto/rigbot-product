// rigbot-product/pages/api/widget.js
export default function handler(req, res) {
  const clientId = req.query.clientId || "demo-client"; 
  const clave = req.query.clave || null;

  // Ya no necesitamos construir el host dinámicamente para el widgetCoreSrc
  // usaremos una ruta relativa.
  const widgetCoreSrc = "/rigbot-widget-core.js"; // ¡Ruta relativa!

  const scriptContent = `
(() => {
  console.log("[Rigbot Loader Script] Ejecutándose en el navegador del cliente.");
  window.RIGBOT_CLIENT_ID = "${String(clientId)}";
  ${clave ? `window.RIGBOT_CLAVE = "${String(clave)}";` : 'delete window.RIGBOT_CLAVE;'}

  console.log("[Rigbot Loader Script] ClientID seteado a:", window.RIGBOT_CLIENT_ID);
  console.log("[Rigbot Loader Script] Clave seteada a:", window.RIGBOT_CLAVE !== undefined ? window.RIGBOT_CLAVE : 'N/A (o eliminada)');
  
  const coreScriptElement = document.createElement("script");
  console.log("[Rigbot Loader Script] Elemento <script> para el core creado.");
  
  const calculatedCoreSrc = "${widgetCoreSrc}"; // Ahora será "/rigbot-widget-core.js"
  console.log("[Rigbot Loader Script] URL calculada para rigbot-widget-core.js:", calculatedCoreSrc);
  
  if (!calculatedCoreSrc) { // Chequeo simple, aunque con ruta relativa es menos probable que falle aquí
    console.error("[Rigbot Loader Script] ERROR: La URL para rigbot-widget-core.js es inválida.");
    return; 
  }

  coreScriptElement.src = calculatedCoreSrc; // El navegador completará esto con el host actual
  coreScriptElement.defer = true;
  
  coreScriptElement.onload = () => {
    console.log("[Rigbot Loader Script] rigbot-widget-core.js CARGADO EXITOSAMENTE desde la ruta relativa:", calculatedCoreSrc);
  };
  
  coreScriptElement.onerror = () => {
    console.error("[Rigbot Loader Script] ERROR AL CARGAR rigbot-widget-core.js usando la ruta relativa:", calculatedCoreSrc);
    const errorDivId = 'rigbot-core-load-error-notifier';
    if (!document.getElementById(errorDivId)) {
        const errorDiv = document.createElement('div');
        errorDiv.id = errorDivId;
        errorDiv.innerText = 'Error: Rigbot no pudo cargar su componente principal (core). Intente recargar la página o contacte a soporte.';
        errorDiv.style.cssText = 'position:fixed; bottom:20px; left:10px; padding:15px; background:darkred; color:white; z-index:10001; border-radius:8px; font-family: sans-serif; font-size: 14px; box-shadow: 0 4px 12px rgba(0,0,0,0.3);';
        document.body.appendChild(errorDiv);
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