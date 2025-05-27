// rigbot-product/pages/api/widget.js
export default function handler(req, res) {
  const clientId = req.query.clientId || "demo-client"; 
  const clave = req.query.clave || null;

  const protocol = process.env.NODE_ENV === 'development' ? 'http://' : 'https://';
  // Para Vercel, process.env.VERCEL_URL es el dominio del deployment actual.
  // Si estás probando localmente rigbot-product y se sirve en un puerto diferente
  // al que accede rigsite-web, podrías tener que ajustar esto o usar la URL completa.
  const host = process.env.VERCEL_URL || (process.env.NODE_ENV === 'development' ? `localhost:${process.env.PORT || 3001}` : 'tu-dominio-de-produccion-rigbot-product.com'); 
  // Asegúrate que 'tu-dominio-de-produccion-rigbot-product.com' sea el dominio correcto de rigbot-product si VERCEL_URL no está disponible.

  const widgetCoreSrc = `<span class="math-inline">\{protocol\}</span>{host}/rigbot-widget-core.js`;

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
    const errorNotifier = document.createElement('div');
    errorNotifier.innerText = 'Error: El asistente Rigbot no pudo cargarse (core).';
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