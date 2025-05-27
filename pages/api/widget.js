// rigbot-product/pages/api/widget.js

export default function handler(req, res) {
  const clientId = req.query.clientId || "demo-client"; 
  const clave = req.query.clave || null;

  // Determina la URL base del rigbot-product.
  // En Vercel, process.env.VERCEL_URL incluye el dominio.
  // Para local, necesitas definirlo o tener un fallback.
  const protocol = process.env.NODE_ENV === 'development' ? 'http://' : 'https://';
  const host = process.env.VERCEL_URL || (process.env.NODE_ENV === 'development' ? 'localhost:3001' : 'tu-dominio-de-produccion-rigbot-product.com'); // Ajusta localhost:3001 si es necesario
  const widgetCoreSrc = `${protocol}${host}/rigbot-widget-core.js`;

  const scriptContent = `
(() => {
  window.RIGBOT_CLIENT_ID = "${String(clientId)}";
  ${clave ? `window.RIGBOT_CLAVE = "${String(clave)}";` : 'delete window.RIGBOT_CLAVE;'}

  console.log("[Rigbot Loader] Inicializando widget con ClientID:", window.RIGBOT_CLIENT_ID, "y Clave:", window.RIGBOT_CLAVE !== undefined ? window.RIGBOT_CLAVE : 'N/A');

  const coreScript = document.createElement("script");
  coreScript.src = "${widgetCoreSrc}";
  coreScript.defer = true;
  coreScript.onerror = () => {
    console.error("[Rigbot Loader] Falló la carga de rigbot-widget-core.js desde ${widgetCoreSrc}");
    // Opcional: Muestra un mensaje de error en la página del usuario
    const errorNotifier = document.createElement('div');
    errorNotifier.innerText = 'Error: El asistente Rigbot no pudo cargarse.';
    errorNotifier.style.cssText = 'position:fixed; bottom:10px; left:10px; padding:10px; background:red; color:white; z-index:10000; border-radius:5px;';
    document.body.appendChild(errorNotifier);
    setTimeout(() => { errorNotifier.remove(); }, 5000);
  };
  document.head.appendChild(coreScript);
})();
  `.trim();

  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.status(200).send(scriptContent);
}