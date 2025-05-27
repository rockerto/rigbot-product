// rigbot-product/pages/api/auth/google/initiate.js
export default async function handler(req, res) {
  const { userId } = req.query; // Este userId es el clientId de Rigbot

  if (!userId) {
    return res.status(400).json({ error: "Falta el parámetro userId en la URL para iniciar la autenticación de Google Calendar." });
  }

  // ----- CORRECCIÓN AQUÍ: Usar los nombres de tus variables de entorno -----
  const googleClientId = process.env.GOOGLE_CLIENT_ID;
  const googleRedirectUri = process.env.GOOGLE_REDIRECT_URI;
  // --------------------------------------------------------------------

  if (!googleClientId || !googleRedirectUri) {
    console.error("Error de configuración en /api/auth/google/initiate.js: Faltan variables de entorno GOOGLE_CLIENT_ID o GOOGLE_REDIRECT_URI. Verifica que estén seteadas en Vercel para el proyecto rigbot-product.");
    console.error("Valores actuales leídos: GOOGLE_CLIENT_ID:", googleClientId, "GOOGLE_REDIRECT_URI:", googleRedirectUri);
    return res.status(500).json({ error: "Error de configuración del servidor para la autenticación con Google. Variables OAuth no encontradas." });
  }

  const scopes = [
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile"
  ];
  const scopeString = scopes.join(" ");

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", googleClientId);
  authUrl.searchParams.set("redirect_uri", googleRedirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", scopeString);
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("state", userId);

  console.log(`Redirigiendo usuario ${userId} a Google para autorización. URL: ${authUrl.toString()}`);
  return res.redirect(authUrl.toString());
}