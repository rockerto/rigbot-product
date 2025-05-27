// rigbot-product/pages/api/widget.js
export default function handler(req, res) {
  const clientId = req.query.clientId || "demo-client"; 
  const clave = req.query.clave || null;

  const protocol = process.env.NODE_ENV === 'development' ? 'http://' : 'https://';
  const host = process.env.VERCEL_URL || (process.env.NODE_ENV === 'development' ? `localhost:${process.env.PORT || 3001}` : 'tu-dominio-de-produccion-rigbot-product.com'); 
  
  // ESTA LÍNEA ES LA IMPORTANTE PARA LA CARGA DEL CORE
  const widgetCoreSrc = `${protocol}${host}/rigbot-widget-core.js`; // <--- CON .js

  const scriptContent = `
(() => {
  window.RIGBOT_CLIENT_ID = "${String(clientId)}";
  ${clave ? `window.RIGBOT_CLAVE = "${String(clave)}";` : 'delete window.RIGBOT_CLAVE;'}

  console.log("[Rigbot Loader] Inicializando widget con ClientID:", window.RIGBOT_CLIENT_ID, "y Clave:", window.RIGBOT_CLAVE !== undefined ? window.RIGBOT_CLAVE : 'N/A');

  const coreScript = document.createElement("script");
  coreScript.src = "${widgetCoreSrc}"; // <--- Usa la variable con .js
  coreScript.defer = true;
  // ... (onerror y appendChild) ...
})();
  `.trim();

  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.status(200).send(scriptContent);
}