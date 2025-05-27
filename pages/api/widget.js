// rigbot-product/pages/api/widget.js
export default function handler(req, res) {
  const clientId = req.query.clientId || "demo-client"; 
  const clave = req.query.clave || null;

  // Define la URL base PÚBLICA y CANÓNICA de tu backend rigbot-product.
  // Usaremos la que me confirmaste.
  const publicBackendDomain = "https://rigbot-product.vercel.app";

  // Construimos la URL absoluta para el script principal del widget
  const widgetCoreSrc = `${publicBackendDomain}/rigbot-widget-core.js`;

  const scriptContent = `
(() => {
  console.log("[Rigbot Loader Script] Ejecutándose en el navegador del cliente.");
  window.RIGBOT_CLIENT_ID = "${String(clientId)}";
  ${clave ? `window.RIGBOT_CLAVE = "${String(clave)}";` : 'delete window.RIGBOT_CLAVE;'}

  console.log("[Rigbot Loader Script] ClientID seteado a:", window.RIGBOT_CLIENT_ID);
  console.log("[Rigbot Loader Script] Clave seteada a:", window.RIGBOT_CLAVE !== undefined ? window.RIGBOT_CLAVE : 'N/A (o eliminada)');
  
  const coreScriptElement = document.createElement("script");
  console.log("[Rigbot Loader Script] Elemento <script> para el core creado.");
  
  const calculatedCoreSrc = "${widgetCoreSrc}"; // Ahora será una URL absoluta
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